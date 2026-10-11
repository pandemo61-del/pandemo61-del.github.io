import sys
import os
import cv2
import numpy as np
import tempfile
import shutil
import json
import zipfile
import rarfile
import hashlib
import re
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass
from typing import List, Tuple
from pdf2image import convert_from_path
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QLabel, QPushButton,
    QFileDialog, QScrollArea, QProgressDialog, QGraphicsScene, QGraphicsView,
    QGraphicsPixmapItem, QMessageBox, QStatusBar, QSpinBox
)
from PyQt6.QtCore import Qt, QSize, QRectF, pyqtSignal
from PyQt6.QtGui import QAction, QActionGroup, QImage, QPixmap, QPainter, QColor, QPen, QPalette, QFont
from PyQt6.QtGui import QGuiApplication
from PyQt6.QtGui import QIcon

E_READERS = {
    "Kobo Libra 2": (1264, 1680),
    "Kobo Sage": (1440, 1920),
    "Kobo Elipsa": (1404, 1872),
    "Kobo Elipsa 2E": (1404, 1872),
    "Kobo Clara Color": (1072, 1448),
    "Kobo Clara 2E": (1072, 1448),
    "Kobo Nia": (1072, 1448),
    "Kobo Forma": (1440, 1920),
    
    "Kindle Oasis 3": (1264, 1680),
    "Kindle Paperwhite 5": (1236, 1648),
    "PocketBook InkPad Color": (1072, 1448),
    "PocketBook InkPad 4": (1200, 1600),
    "Onyx Boox Note Air 2": (1404, 1872),
    "Onyx Boox Nova Air": (1404, 1872),
    "Onyx Boox Leaf": (1404, 1872),
    "Onyx Boox Tab Ultra": (1872, 1404),
    "Onyx Boox Tab Mini C": (1264, 1680),
    "Onyx Boox Nova 3 Color": (1404, 1872),
    "Onyx Boox Poke 3": (1072, 1448),
    "Bookeen Notéa": (1404, 1872),
    "Supernote A5 X": (1404, 1872),
    "Supernote A6 X": (1072, 1404),
    # Ajoute d'autres modèles récents si besoin
}

@dataclass
class Panel:
    x: int
    y: int
    width: int
    height: int
    image: np.ndarray
    confidence: float


def minimum_panel_dimensions(page_width: int, page_height: int) -> Tuple[int, int]:
    return (
        min(page_width, max(100, int(page_width * 0.06))),
        min(page_height, max(100, int(page_height * 0.06))),
    )


def panel_bounds_from_drag(start, end, page_shape):
    page_height, page_width = page_shape[:2]
    min_width, min_height = minimum_panel_dimensions(page_width, page_height)
    x1, y1 = start
    x2, y2 = end
    left, right = sorted((x1, x2))
    top, bottom = sorted((y1, y2))
    left = max(0, left)
    top = max(0, top)
    right = min(page_width, right)
    bottom = min(page_height, bottom)
    if right - left < min_width or bottom - top < min_height:
        return None
    return left, top, right - left, bottom - top


def resized_panel_bounds(bounds, edges, point, page_shape):
    page_height, page_width = page_shape[:2]
    min_width, min_height = minimum_panel_dimensions(page_width, page_height)
    x, y, width, height = bounds
    left, top, right, bottom = x, y, x + width, y + height
    px, py = point
    left_edge, top_edge, right_edge, bottom_edge = edges
    if left_edge:
        left = min(max(px, 0), right - min_width)
    if right_edge:
        right = max(min(px, page_width), left + min_width)
    if top_edge:
        top = min(max(py, 0), bottom - min_height)
    if bottom_edge:
        bottom = max(min(py, page_height), top + min_height)
    return left, top, right - left, bottom - top


class PanelLearningModel:
    FEATURE_COUNT = 11
    MIN_VALIDATION_PAGES = 3
    MIN_SAMPLES_PER_CLASS_PER_PAGE = 1
    MIN_VALIDATION_SCORE = 0.7

    def __init__(self):
        self.parameters = None
        self.validation_score = None

    @staticmethod
    def features(image: np.ndarray, bounds) -> List[float]:
        x, y, width, height = bounds
        page_height, page_width = image.shape[:2]
        x = min(max(int(x), 0), page_width - 1)
        y = min(max(int(y), 0), page_height - 1)
        right = min(page_width, x + int(width))
        bottom = min(page_height, y + int(height))
        if right <= x or bottom <= y:
            raise ValueError("Les dimensions de la case doivent être positives.")

        if image.ndim == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image
        crop = gray[y:bottom, x:right]
        crop_height, crop_width = crop.shape[:2]
        band = max(1, min(crop_width, crop_height) // 20)
        borders = np.concatenate(
            (
                crop[:band, :].ravel(),
                crop[-band:, :].ravel(),
                crop[:, :band].ravel(),
                crop[:, -band:].ravel(),
            )
        )
        inner = crop[band:-band, band:-band]
        if inner.size == 0:
            inner = crop
        edges = cv2.Canny(crop, 50, 150)
        border_edges = np.concatenate(
            (
                edges[:band, :].ravel(),
                edges[-band:, :].ravel(),
                edges[:, :band].ravel(),
                edges[:, -band:].ravel(),
            )
        )
        inner_edges = edges[band:-band, band:-band]
        if inner_edges.size == 0:
            inner_edges = edges
        area_ratio = (crop_width * crop_height) / (page_width * page_height)
        return [
            crop_width / page_width,
            crop_height / page_height,
            area_ratio,
            float(np.log(max(crop_width / crop_height, 1e-6))),
            float(np.mean(edges > 0)),
            float(np.mean(crop)) / 255,
            float(np.std(crop)) / 255,
            float(np.mean(borders)) / 255,
            float(abs(np.mean(borders) - np.mean(inner))) / 255,
            float(np.mean(border_edges > 0)),
            float(np.mean(inner_edges > 0)),
        ]

    @staticmethod
    def _fit_logistic(features, labels):
        mean = np.mean(features, axis=0)
        scale = np.std(features, axis=0)
        scale[scale < 1e-6] = 1.0
        normalized = (features - mean) / scale
        design = np.column_stack((normalized, np.ones(len(normalized))))
        weights = np.zeros(design.shape[1], dtype=np.float64)
        class_counts = np.bincount(labels, minlength=2)
        sample_weights = np.where(
            labels == 1,
            len(labels) / (2 * max(class_counts[1], 1)),
            len(labels) / (2 * max(class_counts[0], 1)),
        )
        for _ in range(600):
            logits = np.clip(design @ weights, -30, 30)
            probabilities = 1 / (1 + np.exp(-logits))
            gradient = (
                design.T @ ((probabilities - labels) * sample_weights) / len(labels)
            )
            gradient[:-1] += 0.01 * weights[:-1]
            weights -= 0.2 * gradient
        return mean, scale, weights

    @classmethod
    def _predict(cls, parameters, features):
        mean, scale, weights = parameters
        normalized = (features - mean) / scale
        design = np.column_stack((normalized, np.ones(len(normalized))))
        logits = np.clip(design @ weights, -30, 30)
        return 1 / (1 + np.exp(-logits))

    def fit(self, pages) -> bool:
        self.parameters = None
        self.validation_score = None
        grouped_samples = {}
        for page_id, entry in pages.items():
            samples = entry.get("samples", []) if isinstance(entry, dict) else []
            page_samples = [
                sample
                for sample in samples
                if isinstance(sample, dict)
                and sample.get("label") in (0, 1)
                and isinstance(sample.get("features"), list)
                and len(sample["features"]) == self.FEATURE_COUNT
            ]
            labels = [sample["label"] for sample in page_samples]
            if all(
                labels.count(label) >= self.MIN_SAMPLES_PER_CLASS_PER_PAGE
                for label in (0, 1)
            ):
                grouped_samples[page_id] = page_samples

        if len(grouped_samples) < self.MIN_VALIDATION_PAGES:
            return False

        validation_scores = []
        for held_out_page in sorted(grouped_samples):
            test_samples = grouped_samples[held_out_page]
            test_labels = np.asarray(
                [sample["label"] for sample in test_samples],
                dtype=np.int64,
            )
            if set(test_labels.tolist()) != {0, 1}:
                return False
            train_samples = [
                sample
                for page_id, samples in grouped_samples.items()
                if page_id != held_out_page
                for sample in samples
            ]
            train_labels = np.asarray(
                [sample["label"] for sample in train_samples],
                dtype=np.int64,
            )
            if set(train_labels.tolist()) != {0, 1}:
                return False
            train_features = np.asarray(
                [sample["features"] for sample in train_samples],
                dtype=np.float64,
            )
            test_features = np.asarray(
                [sample["features"] for sample in test_samples],
                dtype=np.float64,
            )
            validation_model = self._fit_logistic(train_features, train_labels)
            predictions = self._predict(validation_model, test_features) >= 0.5
            true_positive_rate = np.mean(predictions[test_labels == 1])
            true_negative_rate = np.mean(~predictions[test_labels == 0])
            validation_scores.append(
                (true_positive_rate + true_negative_rate) / 2
            )

        self.validation_score = float(np.mean(validation_scores))
        if self.validation_score < self.MIN_VALIDATION_SCORE:
            return False

        all_samples = [
            sample
            for samples in grouped_samples.values()
            for sample in samples
        ]
        all_features = np.asarray(
            [sample["features"] for sample in all_samples],
            dtype=np.float64,
        )
        all_labels = np.asarray(
            [sample["label"] for sample in all_samples],
            dtype=np.int64,
        )
        self.parameters = self._fit_logistic(all_features, all_labels)
        return True

    def filter_panels(self, image: np.ndarray, panels: List["Panel"]) -> List["Panel"]:
        if self.parameters is None or not panels:
            return panels
        features = np.asarray(
            [
                self.features(
                    image,
                    (panel.x, panel.y, panel.width, panel.height),
                )
                for panel in panels
            ],
            dtype=np.float64,
        )
        scores = self._predict(self.parameters, features)
        accepted = [
            panel
            for panel, score in zip(panels, scores)
            if score >= 0.5
        ]
        return accepted or panels


class PanelDetector:
    def __init__(self, min_panel_size=100, brightness_threshold=127):
        self.min_panel_size = min_panel_size
        self.brightness_threshold = brightness_threshold  # Seuil pour fond noir/blanc
        self.min_panel_dimension_ratio = 0.06
        self.min_panel_area_ratio = 0.01
        self._contour_cache = None  # {image, gap: (hiérarchie, boîtes)}

    def detect_panels(self, image: np.ndarray) -> List[Panel]:
        """Détecte les cases dans une image, compatible avec fonds noirs, blancs ou colorés"""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # Type de fond estimé sur les marges de la page (et non sur la luminosité
        # moyenne, faussée par les planches sombres à marges blanches).
        background = self._estimate_background(image)
        if background["reliable"]:
            is_dark_background = background["gray"] < self.brightness_threshold
        else:
            is_dark_background = np.mean(gray) < self.brightness_threshold

        # Méthode 0: écart à la couleur du fond + hiérarchie des contours
        gutter_panels = self._detect_with_background_difference(image, background)

        # Méthode 1: Seuillage adaptatif (original amélioré)
        panels1 = self._detect_with_adaptive_threshold(gray, image, is_dark_background)

        # Méthode 2: Détection par contours avec seuillage Otsu
        panels2 = self._detect_with_otsu_threshold(gray, image, is_dark_background)

        # Méthode 3: Détection par différence de luminosité
        panels3 = self._detect_with_brightness_difference(gray, image)

        page_area = gray.shape[0] * gray.shape[1]
        panels2 = [
            panel for panel in panels2
            if panel.width * panel.height < page_area * 0.85
        ]
        panels3 = [
            panel for panel in panels3
            if panel.width * panel.height >= page_area * 0.02
            or any(
                self._intersection_over_union(panel, other) >= 0.3
                for other in panels1 + panels2 + gutter_panels
            )
        ]

        legacy_panels = [
            panel for panel in panels1 + panels2 + panels3
            if panel.width * panel.height < page_area * 0.85
        ]

        # Quand les gouttières délimitent clairement au moins deux cases, cette
        # détection fait foi : les anciennes méthodes ne servent qu'à retrouver
        # des cases isolées qu'elle aurait manquées (jamais à fusionner ou
        # redécouper des cases déjà délimitées).
        if len(gutter_panels) >= 2:
            extras = [
                panel for panel in legacy_panels
                if panel.width * panel.height >= page_area * 0.03
                and all(
                    self._overlap_over_smaller(panel, gutter) < 0.3
                    for gutter in gutter_panels
                )
            ]
            unique_panels = self._remove_duplicates(gutter_panels + extras)
            final_panels = self._sort_panels(unique_panels)
            return self._filter_unreasonably_small_panels(final_panels, image)

        # Combine candidates and discard page-sized boxes that merge separate panels.
        all_panels = self._merge_fragmented_panels(gutter_panels + legacy_panels, image)

        # Suppression des doublons et tri
        unique_panels = self._remove_duplicates(all_panels)
        sorted_panels = self._sort_panels(unique_panels)

        # Filtrage final
        final_panels = self._filter_overlapping_panels(sorted_panels)
        self._extend_truncated_panels(final_panels, image)
        self._repair_bottom_left_panel(final_panels, image)
        return self._filter_unreasonably_small_panels(final_panels, image)

    def detect_panels_for_count(
        self,
        image: np.ndarray,
        desired_count: int,
        candidate_filter=None,
    ) -> List[Panel]:
        """Tune detection and size-filter thresholds to approach the requested count."""
        if desired_count <= 0:
            return []
        original_min_size = self.min_panel_size
        original_dimension_ratio = self.min_panel_dimension_ratio
        original_area_ratio = self.min_panel_area_ratio
        threshold_options = {
            max(40, int(original_min_size * factor))
            for factor in (
                0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25,
                1.5, 1.8, 2.2, 2.6,
            )
        }
        threshold_options.update(
            max(40, int(min(image.shape[:2]) * factor))
            for factor in (0.08, 0.1, 0.12)
        )
        thresholds = sorted(
            threshold_options,
            key=lambda value: (abs(value - original_min_size), value),
        )
        filter_settings = ((0.06, 0.01),)
        best_panels = []
        best_key = None
        try:
            for setting_index, (dimension_ratio, area_ratio) in enumerate(
                filter_settings
            ):
                self.min_panel_dimension_ratio = dimension_ratio
                self.min_panel_area_ratio = area_ratio
                for threshold in thresholds:
                    self.min_panel_size = threshold
                    detected_panels = self.detect_panels(image)
                    panels = (
                        candidate_filter(detected_panels)
                        if candidate_filter is not None
                        else detected_panels
                    )
                    candidate_key = (
                        abs(len(panels) - desired_count),
                        setting_index,
                        abs(threshold - original_min_size),
                    )
                    if best_key is None or candidate_key < best_key:
                        best_panels = panels
                        best_key = candidate_key
                    if len(panels) == desired_count:
                        return panels

            if len(best_panels) < desired_count:
                relaxed_thresholds = sorted(
                    {
                        max(40, int(original_min_size * factor))
                        for factor in (0.5, 0.8, 1, 1.2)
                    },
                    key=lambda value: (abs(value - original_min_size), value),
                )
                for setting_index, (dimension_ratio, area_ratio) in enumerate(
                    (
                        (0.05, 0.0075),
                        (0.04, 0.005),
                        (0.03, 0.0025),
                    ),
                    start=1,
                ):
                    self.min_panel_dimension_ratio = dimension_ratio
                    self.min_panel_area_ratio = area_ratio
                    for threshold in relaxed_thresholds:
                        self.min_panel_size = threshold
                        detected_panels = self.detect_panels(image)
                        panels = (
                            candidate_filter(detected_panels)
                            if candidate_filter is not None
                            else detected_panels
                        )
                        candidate_key = (
                            abs(len(panels) - desired_count),
                            setting_index,
                            abs(threshold - original_min_size),
                        )
                        if best_key is None or candidate_key < best_key:
                            best_panels = panels
                            best_key = candidate_key
                        if len(panels) == desired_count:
                            return panels
        finally:
            self.min_panel_size = original_min_size
            self.min_panel_dimension_ratio = original_dimension_ratio
            self.min_panel_area_ratio = original_area_ratio
        return best_panels

    @staticmethod
    def _estimate_background(image: np.ndarray) -> dict:
        """Estime la couleur du fond de la page à partir de ses marges."""
        height, width = image.shape[:2]
        band = max(3, int(min(height, width) * 0.015))
        strips = np.concatenate(
            (
                image[:band].reshape(-1, 3),
                image[-band:].reshape(-1, 3),
                image[:, :band].reshape(-1, 3),
                image[:, -band:].reshape(-1, 3),
            )
        )
        color = np.median(strips, axis=0)
        distance = np.abs(strips.astype(np.int16) - color.astype(np.int16)).max(axis=1)
        close = distance <= 30
        noise = float(np.percentile(distance[close], 99)) if close.any() else 0.0
        gray = float(
            0.114 * color[0] + 0.587 * color[1] + 0.299 * color[2]
        )
        return {
            "color": color.astype(np.uint8),
            "gray": gray,
            # Tolérance adaptée au bruit de scan / compression JPEG
            "tolerance": int(min(40, max(18, noise * 1.5 + 4))),
            # Si les marges sont occupées par du dessin, le fond est incertain
            "reliable": bool(close.mean() >= 0.6),
        }

    def _detect_with_background_difference(
        self,
        image: np.ndarray,
        background: dict,
    ) -> List[Panel]:
        """Détecte les cases comme zones qui diffèrent de la couleur du fond.

        Fonctionne quelle que soit la couleur du fond (blanc, crème, noir...) et
        du contenu (cadres seuls, dessin plein, couleurs claires). Lorsqu'un
        contour englobe toute la page (cadre de planche, bord de scan), on
        descend dans la hiérarchie des contours pour y retrouver les vraies cases.

        L'analyse se fait à deux échelles : une fermeture morphologique large
        (referme les cadres interrompus) et une fine (sépare les cases dont la
        gouttière est très étroite). Une case "large" n'est remplacée par des
        cases "fines" que si elles la recouvrent presque entièrement.
        """
        if not background["reliable"]:
            return []
        page_height, page_width = image.shape[:2]
        coarse_gap = max(3, int(min(page_height, page_width) * 0.004))
        fine_gap = max(2, coarse_gap // 3)

        coarse = self._panels_from_mask(image, background, coarse_gap)
        if fine_gap >= coarse_gap:
            return coarse
        fine = self._panels_from_mask(image, background, fine_gap)

        refined: List[Panel] = []
        for big in coarse:
            parts = [
                small for small in fine
                if self._overlap_over_smaller(small, big) >= 0.9
                and small.width * small.height < big.width * big.height * 0.9
            ]
            covered = sum(part.width * part.height for part in parts)
            overlap_free = all(
                self._overlap_over_smaller(first, second) < 0.1
                for index, first in enumerate(parts)
                for second in parts[index + 1:]
            )
            if (
                len(parts) >= 2
                and overlap_free
                and covered >= big.width * big.height * 0.8
            ):
                refined.extend(parts)
            else:
                refined.append(big)
        return refined

    def _panels_from_mask(
        self,
        image: np.ndarray,
        background: dict,
        gap: int,
    ) -> List[Panel]:
        page_height, page_width = image.shape[:2]
        page_area = page_height * page_width

        # Le masque ne dépend pas des seuils de taille : on le calcule une seule
        # fois par page et par échelle (detect_panels_for_count rappelle
        # detect_panels très souvent).
        cache = self._contour_cache
        if cache is None or cache["image"] is not image:
            cache = self._contour_cache = {"image": image}
        if "mask" not in cache:
            diff = cv2.absdiff(
                image, np.full_like(image, background["color"])
            ).max(axis=2)
            diff = cv2.medianBlur(diff, 3)
            mask = (diff > background["tolerance"]).astype(np.uint8) * 255
            # Supprime les petites taches isolées (poussière, repères
            # d'impression) qui pourraient relier deux cases à travers la gouttière.
            speck = max(6, int(min(page_height, page_width) * 0.006))
            count, labels, stats, _ = cv2.connectedComponentsWithStats(
                mask, connectivity=8
            )
            keep = (stats[:, cv2.CC_STAT_WIDTH] >= speck) | (
                stats[:, cv2.CC_STAT_HEIGHT] >= speck
            )
            keep[0] = False  # le fond
            cache["mask"] = keep[labels].astype(np.uint8) * 255
        if gap not in cache:
            # Referme les cadres interrompus sans combler les gouttières
            mask = cv2.morphologyEx(
                cache["mask"],
                cv2.MORPH_CLOSE,
                cv2.getStructuringElement(cv2.MORPH_RECT, (gap, gap)),
            )
            contours, hierarchy = cv2.findContours(
                mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
            )
            hierarchy = hierarchy[0] if hierarchy is not None else []
            cache[gap] = (hierarchy, [cv2.boundingRect(c) for c in contours])
        hierarchy, boxes = cache[gap]
        if len(boxes) == 0:
            return []
        min_size = self.min_panel_size

        def children(index):
            child = hierarchy[index][2]
            while child != -1:
                yield child
                child = hierarchy[child][0]

        def is_sizeable(index):
            return boxes[index][2] >= min_size and boxes[index][3] >= min_size

        panels: List[Panel] = []
        stack = [
            (index, False) for index in range(len(boxes)) if hierarchy[index][3] == -1
        ]
        while stack:
            index, inside_container = stack.pop()
            x, y, w, h = boxes[index]
            area_ratio = (w * h) / page_area
            sizeable_children = sum(is_sizeable(child) for child in children(index))
            is_container = area_ratio >= 0.85 or (
                inside_container and area_ratio >= 0.5 and sizeable_children >= 2
            )
            if is_container:
                stack.extend((child, True) for child in children(index))
                continue
            if w < min_size or h < min_size or max(w, h) / min(w, h) >= 10:
                continue
            panels.append(Panel(x, y, w, h, image[y:y + h, x:x + w], 0.9))
        return panels

    @staticmethod
    def _overlap_over_smaller(first: Panel, second: Panel) -> float:
        x1 = max(first.x, second.x)
        y1 = max(first.y, second.y)
        x2 = min(first.x + first.width, second.x + second.width)
        y2 = min(first.y + first.height, second.y + second.height)
        if x2 <= x1 or y2 <= y1:
            return 0.0
        smaller = min(first.width * first.height, second.width * second.height)
        return (x2 - x1) * (y2 - y1) / smaller

    def _detect_with_adaptive_threshold(
        self,
        gray: np.ndarray,
        original_image: np.ndarray,
        is_dark_background: bool,
    ) -> List[Panel]:
        """Détection avec seuillage adaptatif amélioré"""
        panels = []
        
        # Paramètres adaptés selon le type de fond
        if is_dark_background:
            # Pour fond noir : inverser la logique
            thresh = cv2.adaptiveThreshold(
                gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv2.THRESH_BINARY, 15, 5  # Paramètres ajustés pour fond noir
            )
        else:
            # Pour fond blanc : logique originale
            thresh = cv2.adaptiveThreshold(
                gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv2.THRESH_BINARY_INV, 11, 2
            )
        
        # Nettoyage morphologique
        kernel = np.ones((3,3), np.uint8)
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)
        
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if w >= self.min_panel_size and h >= self.min_panel_size:
                # Calcul de confiance amélioré
                roi = thresh[y:y+h, x:x+w]
                confidence = self._calculate_confidence(roi, is_dark_background)
                
                if confidence > 0.1:  # Seuil de confiance ajusté
                    panel_image = original_image[y:y+h, x:x+w]
                    panels.append(Panel(x, y, w, h, panel_image, confidence))
        
        return panels

    def _detect_with_otsu_threshold(self, gray: np.ndarray, original_image: np.ndarray, is_dark_background: bool) -> List[Panel]:
        """Détection avec seuillage d'Otsu"""
        panels = []
        
        # Seuillage d'Otsu
        _, thresh_otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        if is_dark_background:
            thresh_otsu = cv2.bitwise_not(thresh_otsu)
        
        # Nettoyage morphologique plus agressif
        kernel = np.ones((5,5), np.uint8)
        thresh_otsu = cv2.morphologyEx(thresh_otsu, cv2.MORPH_CLOSE, kernel)
        thresh_otsu = cv2.morphologyEx(thresh_otsu, cv2.MORPH_OPEN, kernel)
        
        contours, _ = cv2.findContours(thresh_otsu, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if w >= self.min_panel_size and h >= self.min_panel_size:
                # Vérification de la forme (ratio largeur/hauteur raisonnable)
                ratio = max(w, h) / min(w, h)
                if ratio < 10:  # Évite les lignes trop fines
                    panel_image = original_image[y:y+h, x:x+w]
                    confidence = 0.8  # Confiance élevée pour Otsu
                    panels.append(Panel(x, y, w, h, panel_image, confidence))
        
        return panels

    def _detect_with_brightness_difference(self, gray: np.ndarray, original_image: np.ndarray) -> List[Panel]:
        """Détection basée sur les différences de luminosité"""
        panels = []
        
        # Détection des bords avec Canny
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)
        
        # Dilatation pour connecter les bords proches
        kernel = np.ones((3,3), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=2)
        
        # Fermeture pour créer des contours fermés
        kernel = np.ones((7,7), np.uint8)
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)
        
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if w >= self.min_panel_size and h >= self.min_panel_size:
                # Vérification de la variance à l'intérieur de la zone
                roi = gray[y:y+h, x:x+w]
                variance = np.var(roi)
                
                if variance > 100:  # Seuil de variance pour s'assurer qu'il y a du contenu
                    panel_image = original_image[y:y+h, x:x+w]
                    confidence = min(variance / 1000, 1.0)  # Normalisation de la confiance
                    panels.append(Panel(x, y, w, h, panel_image, confidence))
        
        return panels

    def _merge_fragmented_panels(
        self,
        panels: List[Panel],
        image: np.ndarray,
    ) -> List[Panel]:
        """Merge candidate rectangles that overlap as fragments of one panel."""
        if len(panels) < 2:
            return panels

        vertical_gap_tolerance = max(5, int(image.shape[0] * 0.005))
        merged_panels = panels.copy()
        changed = True

        while changed:
            changed = False
            for first_index, first in enumerate(merged_panels):
                for second_index in range(first_index + 1, len(merged_panels)):
                    second = merged_panels[second_index]
                    overlap_width = max(
                        0,
                        min(first.x + first.width, second.x + second.width)
                        - max(first.x, second.x),
                    )
                    overlap_height = max(
                        0,
                        min(first.y + first.height, second.y + second.height)
                        - max(first.y, second.y),
                    )
                    horizontal_overlap = overlap_width / min(first.width, second.width)
                    vertical_overlap = overlap_height / min(first.height, second.height)
                    vertical_gap = max(
                        0,
                        max(first.y, second.y)
                        - min(first.y + first.height, second.y + second.height),
                    )

                    fragments_overlap = (
                        horizontal_overlap >= 0.1 and vertical_overlap >= 0.5
                    )
                    fragments_touch = (
                        horizontal_overlap >= 0.5
                        and vertical_gap <= vertical_gap_tolerance
                    )
                    if not (fragments_overlap or fragments_touch):
                        continue

                    x1 = min(first.x, second.x)
                    y1 = min(first.y, second.y)
                    x2 = max(first.x + first.width, second.x + second.width)
                    y2 = max(first.y + first.height, second.y + second.height)
                    merged_panels[first_index] = Panel(
                        x1,
                        y1,
                        x2 - x1,
                        y2 - y1,
                        image[y1:y2, x1:x2],
                        max(first.confidence, second.confidence),
                    )
                    merged_panels.pop(second_index)
                    changed = True
                    break
                if changed:
                    break

        return merged_panels

    def _calculate_confidence(self, roi: np.ndarray, is_dark_background: bool) -> float:
        """Calcul de confiance amélioré selon le type de fond"""
        if is_dark_background:
            # Pour fond noir : cherche les pixels blancs (contenu)
            white_pixels = np.sum(roi > 200)
            total_pixels = roi.shape[0] * roi.shape[1]
            confidence = white_pixels / total_pixels
        else:
            # Pour fond blanc : logique originale
            confidence = np.sum(roi > 0) / (roi.shape[0] * roi.shape[1])
        
        return confidence

    def _remove_duplicates(self, panels: List[Panel]) -> List[Panel]:
        """Supprime les panels en double basé sur le chevauchement"""
        if not panels:
            return []
        
        # Trie par confiance décroissante
        sorted_panels = sorted(panels, key=lambda p: p.confidence, reverse=True)
        unique_panels = []
        
        for panel in sorted_panels:
            duplicate_indices = []
            panel_area = panel.width * panel.height
            for index, existing in enumerate(unique_panels):
                overlap = self._calculate_overlap(panel, existing)
                existing_area = existing.width * existing.height
                intersection_over_smaller = overlap / min(panel_area, existing_area)
                if (
                    self._intersection_over_union(panel, existing) > 0.5
                    or intersection_over_smaller >= 0.85
                ):
                    if panel_area > existing_area and intersection_over_smaller >= 0.85:
                        duplicate_indices.append(index)
                    else:
                        break
            else:
                for index in reversed(duplicate_indices):
                    unique_panels.pop(index)
                unique_panels.append(panel)
        
        return unique_panels

    def _calculate_overlap(self, panel1: Panel, panel2: Panel) -> float:
        """Calcule l'aire de chevauchement entre deux panels"""
        x1 = max(panel1.x, panel2.x)
        y1 = max(panel1.y, panel2.y)
        x2 = min(panel1.x + panel1.width, panel2.x + panel2.width)
        y2 = min(panel1.y + panel1.height, panel2.y + panel2.height)
        
        if x2 <= x1 or y2 <= y1:
            return 0
        
        return (x2 - x1) * (y2 - y1)

    def _intersection_over_union(self, panel1: Panel, panel2: Panel) -> float:
        overlap_area = self._calculate_overlap(panel1, panel2)
        if overlap_area == 0:
            return 0.0
        union_area = (
            panel1.width * panel1.height
            + panel2.width * panel2.height
            - overlap_area
        )
        return overlap_area / union_area

    def _filter_overlapping_panels(self, panels: List[Panel]) -> List[Panel]:
        """Filter duplicate detections without discarding substantially different panels."""
        return self._remove_duplicates(panels)

    def _extend_truncated_panels(self, panels: List[Panel], image: np.ndarray) -> None:
        """Extend a short panel to its row height when no following row would be covered."""
        if len(panels) < 2:
            return

        sorted_panels = sorted(panels, key=lambda p: (p.y, p.x))
        rows: List[List[Panel]] = []
        for panel in sorted_panels:
            if not rows or abs(panel.y - rows[-1][0].y) >= 20:
                rows.append([panel])
            else:
                rows[-1].append(panel)

        for row_index, row in enumerate(rows):
            if len(row) < 2:
                continue

            heights = sorted(panel.height for panel in row)
            median_height = heights[len(heights) // 2]
            target_height = heights[-1]
            if target_height > median_height * 1.1:
                continue

            if row_index + 1 < len(rows):
                next_row_y = rows[row_index + 1][0].y
                if max(panel.y + target_height for panel in row) > next_row_y:
                    continue

            for panel in row:
                if panel.height < target_height * 0.8:
                    panel.height = min(target_height, image.shape[0] - panel.y)
                    panel.image = image[
                        panel.y:panel.y + panel.height,
                        panel.x:panel.x + panel.width,
                    ]

    def _repair_bottom_left_panel(self, panels: List[Panel], image: np.ndarray) -> None:
        """Infer missing bottom-left borders from panels with comparable dimensions."""
        if len(panels) < 2:
            return

        page_height, page_width = image.shape[:2]
        rows = self._group_panels_into_rows(panels)
        bottom_row = max(rows, key=lambda row: min(p.y for p in row))
        left_panel = min(bottom_row, key=lambda panel: panel.x)

        if left_panel.x > page_width * 0.25 or left_panel.y + left_panel.height < page_height * 0.7:
            return

        same_row_peers = [panel for panel in bottom_row if panel is not left_panel]
        other_left_panels = [
            min(row, key=lambda panel: panel.x)
            for row in rows
            if row is not bottom_row
            and abs(min(panel.x for panel in row) - left_panel.x) <= page_width * 0.15
        ]
        reference_panel = (
            min(
                other_left_panels,
                key=lambda panel: abs(panel.y + panel.height - left_panel.y),
            )
            if other_left_panels
            else None
        )
        width_peers = [reference_panel] if reference_panel else same_row_peers
        height_peers = same_row_peers
        if not width_peers and not height_peers:
            return

        if width_peers:
            target_width = int(np.median([panel.width for panel in width_peers]))
        else:
            target_width = left_panel.width
        target_x = reference_panel.x if reference_panel else left_panel.x
        needs_width_repair = (
            left_panel.width < target_width * 0.65
            or target_x < left_panel.x - page_width * 0.04
        )
        if needs_width_repair:
            next_panel_x = min(
                (panel.x for panel in same_row_peers if panel.x > target_x),
                default=page_width,
            )
            left_panel.x = target_x
            left_panel.width = min(target_width, next_panel_x - target_x)

        if height_peers:
            target_height = int(np.median([panel.height for panel in height_peers]))
        else:
            target_height = left_panel.height
        if height_peers and left_panel.height < target_height * 0.65:
            row_bottom = max(
                [left_panel.y + left_panel.height]
                + [panel.y + panel.height for panel in height_peers]
            )
            left_panel.height = min(target_height, row_bottom)
            left_panel.y = max(0, row_bottom - left_panel.height)

        left_panel.width = min(left_panel.width, page_width - left_panel.x)
        left_panel.height = min(left_panel.height, page_height - left_panel.y)
        left_panel.image = image[
            left_panel.y:left_panel.y + left_panel.height,
            left_panel.x:left_panel.x + left_panel.width,
        ]

    def _filter_unreasonably_small_panels(
        self,
        panels: List[Panel],
        image: np.ndarray,
    ) -> List[Panel]:
        """Discard detections that are too small relative to the source page."""
        page_height, page_width = image.shape[:2]
        minimum_size = max(self.min_panel_size, 100)
        min_width = max(
            minimum_size,
            int(page_width * self.min_panel_dimension_ratio),
        )
        min_height = max(
            minimum_size,
            int(page_height * self.min_panel_dimension_ratio),
        )
        min_area = max(
            minimum_size ** 2,
            int(page_width * page_height * self.min_panel_area_ratio),
        )

        return [
            panel for panel in panels
            if panel.width >= min_width
            and panel.height >= min_height
            and panel.width * panel.height >= min_area
        ]

    def _group_panels_into_rows(self, panels: List[Panel]) -> List[List[Panel]]:
        """Group panels with nearby top edges without merging vertically stacked rows."""
        if not panels:
            return []
        panels = sorted(panels, key=lambda p: (p.y, p.x))
        rows: List[List[Panel]] = []

        for panel in panels:
            matching_rows = []
            for row in rows:
                row_y = int(np.median([peer.y for peer in row]))
                row_height = int(np.median([peer.height for peer in row]))
                y_tolerance = max(20, int(min(panel.height, row_height) * 0.15))
                y_distance = abs(panel.y - row_y)
                if y_distance < y_tolerance:
                    matching_rows.append((y_distance, row))

            if not matching_rows:
                rows.append([panel])
            else:
                _, closest_row = min(matching_rows, key=lambda match: match[0])
                closest_row.append(panel)

        for row in rows:
            row.sort(key=lambda p: (p.x, p.y))
        return sorted(rows, key=lambda row: int(np.median([panel.y for panel in row])))

    def _sort_panels(self, panels: List[Panel]) -> List[Panel]:
        """Tri des panels - inchangé"""
        return sorted(panels, key=lambda p: (p.y, p.x))

    @staticmethod
    def sort_panels_for_reading_order(panels: List[Panel]) -> List[Panel]:
        """Ordre de lecture occidental : de haut en bas, de gauche à droite.

        Découpe récursive de la planche (XY-cut) : on cherche d'abord une ligne
        horizontale qu'aucune case ne traverse (→ bandes lues de haut en bas),
        sinon une ligne verticale (→ colonnes lues de gauche à droite), puis on
        recommence dans chaque morceau. Une petite tolérance absorbe les cadres
        qui se chevauchent de quelques pixels. Si la mise en page n'est pas
        découpable (cases en L, en moulinet...), on lit par rangées de cases dont
        le haut est à peu près à la même hauteur.
        """
        def bounds(panel, axis):
            if axis == 1:
                return panel.y, panel.y + panel.height
            return panel.x, panel.x + panel.width

        def split(items, axis):
            ordered = sorted(items, key=lambda p: bounds(p, axis))
            low = min(bounds(p, axis)[0] for p in ordered)
            high = max(bounds(p, axis)[1] for p in ordered)
            tolerance = (high - low) * 0.015
            groups = [[ordered[0]]]
            group_end = bounds(ordered[0], axis)[1]
            for panel in ordered[1:]:
                start, end = bounds(panel, axis)
                if start >= group_end - tolerance:
                    groups.append([panel])
                    group_end = end
                else:
                    groups[-1].append(panel)
                    group_end = max(group_end, end)
            return groups

        def by_rows(items):
            ordered = sorted(items, key=lambda p: (p.y, p.x))
            tolerance = 0.15 * float(np.median([p.height for p in ordered]))
            rows: List[List[Panel]] = []
            for panel in ordered:
                if rows and panel.y - rows[-1][0].y <= tolerance:
                    rows[-1].append(panel)
                else:
                    rows.append([panel])
            return [p for row in rows for p in sorted(row, key=lambda p: (p.x, p.y))]

        def order(items):
            if len(items) <= 1:
                return list(items)
            for axis in (1, 0):  # bandes horizontales d'abord, puis colonnes
                groups = split(items, axis)
                if len(groups) > 1:
                    return [p for group in groups for p in order(group)]
            return by_rows(items)

        return order(list(panels))

class FileHandler:
    def __init__(self):
        self.temp_dir = None
        self.current_file = None
        self.pages = []

    def open_file(self, file_path: str) -> int:
        self.cleanup()
        self.current_file = file_path
        self.temp_dir = tempfile.mkdtemp()
        ext = Path(file_path).suffix.lower()
        if ext == '.pdf':
            return self._handle_pdf()
        elif ext in ('.cbz', '.zip'):
            return self._handle_cbz()
        elif ext in ('.cbr', '.rar'):  # NOUVEAU : Support CBR/RAR
            return self._handle_cbr()
        else:
            raise ValueError(f"Format de fichier non supporté: {ext}")
        
    def _handle_pdf(self) -> int:
        
        self.pages = []
        # Determine the number of threads to use for PDF conversion
        # os.cpu_count() returns the number of CPUs in the system
        # It might return None on some systems, so we default to 1 thread.
        num_threads = os.cpu_count()
        if num_threads is None or num_threads < 1:
            num_threads = 1  # Fallback to a single thread

        pages = convert_from_path(self.current_file, thread_count=num_threads)
        
        for i, page in enumerate(pages):
            page_path = os.path.join(self.temp_dir, f"page_{i:04d}.jpg")
            page.save(page_path, "JPEG")
            self.pages.append(page_path)
        return len(self.pages)


    IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.gif', '.bmp')

    @classmethod
    def _natural_sort_key(cls, filename):
        """Clé de tri naturel : "page 2" < "page 10", insensible à la casse,
        identique sur tous les systèmes (les nombres sont comparés comme nombres)."""
        normalized = filename.replace("\\", "/")
        chunks = [chunk for chunk in re.split(r"(\d+)", normalized) if chunk != ""]
        return (
            [
                (0, int(chunk), "") if chunk.isdigit() else (1, 0, chunk.casefold())
                for chunk in chunks
            ],
            normalized,  # départage "01" et "1", ou deux noms ne différant que par la casse
        )

    @classmethod
    def _sorted_image_entries(cls, names):
        """Garde uniquement les images de l'archive, dans l'ordre naturel."""
        images = []
        for name in names:
            normalized = name.replace("\\", "/")
            base = normalized.rsplit("/", 1)[-1]
            if (
                normalized.endswith("/")
                or normalized.startswith("__MACOSX/")
                or base.startswith(".")
                or not base.lower().endswith(cls.IMAGE_EXTENSIONS)
            ):
                continue
            images.append(name)
        return sorted(images, key=cls._natural_sort_key)

    def _page_path(self, index: int) -> str:
        return os.path.join(self.temp_dir, f"page_{index:04d}.jpg")

    def _handle_cbz(self) -> int:
        self.pages = []
        with zipfile.ZipFile(self.current_file, 'r') as zf:
            for i, img_file in enumerate(self._sorted_image_entries(zf.namelist())):
                # Écrit directement sous le nom final : pas d'extraction suivie d'un
                # renommage, qui pouvait écraser une page si l'archive contenait déjà
                # des fichiers nommés page_XXXX.jpg (ex. un CBZ exporté par l'app).
                new_path = self._page_path(i)
                with zf.open(img_file) as source, open(new_path, 'wb') as target:
                    shutil.copyfileobj(source, target)
                self.pages.append(new_path)
        return len(self.pages)

    def _handle_cbr(self) -> int:
        """Traite les fichiers CBR (Comic Book RAR)"""
        self.pages = []

        try:
            with rarfile.RarFile(self.current_file, 'r') as rf:
                for i, img_file in enumerate(self._sorted_image_entries(rf.namelist())):
                    new_path = self._page_path(i)
                    with open(new_path, 'wb') as target:
                        target.write(rf.read(img_file))
                    self.pages.append(new_path)

        except rarfile.RarCannotExec:
            raise ValueError("Impossible d'extraire le fichier RAR. Vérifiez que WinRAR ou unrar est installé.")
        except Exception as e:
            raise ValueError(f"Erreur lors de l'ouverture du fichier CBR: {str(e)}")

        return len(self.pages)

    def get_page(self, index: int) -> np.ndarray:
        if 0 <= index < len(self.pages):
            return cv2.imread(self.pages[index])
        raise IndexError("Index de page invalide")

    @staticmethod
    def exported_page_name(page_idx: int) -> str:
        """Page entière : numéro de page puis "_000", pour passer avant ses cases."""
        return f"page_{page_idx:04d}_000_page.jpg"

    @staticmethod
    def exported_panel_name(page_idx: int, panel_number: int) -> str:
        """Case n°N de la page : ne diffère de la page entière que par un chiffre,
        donc l'ordre alphabétique, numérique et celui de l'Explorateur Windows
        sont tous identiques à l'ordre de lecture."""
        return f"page_{page_idx:04d}_{panel_number:03d}_panel.jpg"

    def save_cbz(self, output_path: str, panels_by_page: List[List['Panel']], e_reader_resolution=None, progress_callback=None):
        if not output_path.endswith('.cbz'):
            output_path += '.cbz'
        output_dir = os.path.join(os.path.dirname(output_path), "Output")
        os.makedirs(output_dir, exist_ok=True)
        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for page_idx, rows in enumerate(panels_by_page):
                page_path = self.pages[page_idx]
                arc_name = self.exported_page_name(page_idx)
                zf.write(page_path, arc_name)
                if progress_callback:
                    progress_callback()
                panel_count = 1
                panels = PanelDetector.sort_panels_for_reading_order(
                    [panel for row in rows for panel in row]
                )
                for p in panels:
                    panel_img = p.image
                    if panel_img.ndim == 2:
                        panel_img = cv2.cvtColor(panel_img, cv2.COLOR_GRAY2BGR)
                    if e_reader_resolution:
                        target_width, target_height = e_reader_resolution
                        panel_height, panel_width = panel_img.shape[:2]

                        ratio = min(target_width / panel_width, target_height / panel_height)
                        new_width = int(panel_width * ratio)
                        new_height = int(panel_height * ratio)
                        panel_img = cv2.resize(
                            panel_img,
                            (new_width, new_height),
                            interpolation=cv2.INTER_AREA,
                        )
                        if new_width != target_width or new_height != target_height:
                            padded_img = np.zeros((target_height, target_width, 3), dtype=np.uint8)
                            y_offset = (target_height - new_height) // 2
                            x_offset = (target_width - new_width) // 2
                            padded_img[
                                y_offset:y_offset + new_height,
                                x_offset:x_offset + new_width,
                            ] = panel_img
                            panel_img = padded_img
                    panel_name = self.exported_panel_name(page_idx, panel_count)
                    temp_panel_path = os.path.join(output_dir, panel_name)
                    cv2.imwrite(temp_panel_path, panel_img)
                    zf.write(temp_panel_path, panel_name)
                    panel_count += 1
                    if progress_callback:
                        progress_callback()

    def cleanup(self):
        if self.temp_dir and os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)
            self.temp_dir = None
        self.current_file = None
        self.pages = []

class MainWindow(QMainWindow):
    CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".bdsplit_config.json")
    PANEL_TRAINING_PATH = os.path.join(
        os.path.expanduser("~"),
        ".bdsplit_panel_training.json",
    )
    SAMPLE_DIRECTORY = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "test_pages",
    )

    def __init__(self):
        super().__init__()
        self.input_dir = os.path.expanduser("~")
        self.output_dir = os.path.expanduser("~")
        self.color_mode = "système"
        self.file_handler = FileHandler()
        self.panel_detector = PanelDetector()
        self.current_page = 0
        self.total_pages = 0
        self.panels_by_page = []
        self.selected_panel_idx = None  # Pour l'échange de cases
        self.edit_mode = False
        self.selected_panel = None
        self.drag_start = None
        self.drag_current = None
        self.resize_edges = None
        self.resize_start_bounds = None
        self.training_examples = {}
        self.panel_learning_model = PanelLearningModel()
        self.expected_panel_counts = {}
        self.modified_page_indices = set()
        self.detected_boxes_by_page = []
        self.recent_files = []
        self.e_reader_model = None
        self.e_reader_resolution = None
        self.load_config()  # Charger la configuration au démarrage
        self.init_ui()

    def load_config(self):
        if os.path.exists(self.CONFIG_PATH):
            try:
                with open(self.CONFIG_PATH, "r", encoding="utf-8") as f:
                    config = json.load(f)
                self.input_dir = config.get("input_dir", os.path.expanduser("~"))
                self.output_dir = config.get("output_dir", os.path.expanduser("~"))
                self.color_mode = config.get("color_mode", "système")
                self.recent_files = config.get("recent_files", [])
                self.e_reader_model = config.get("e_reader_model")
                self.e_reader_resolution = tuple(config.get("e_reader_resolution")) if config.get("e_reader_resolution") else None
            except Exception:
                pass

    def save_config(self):
        config = {
            "input_dir": self.input_dir,
            "output_dir": self.output_dir,
            "color_mode": self.color_mode,
            "recent_files": getattr(self, "recent_files", []),
            "e_reader_model": self.e_reader_model,
            "e_reader_resolution": self.e_reader_resolution,
        }
        try:
            with open(self.CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(config, f)
        except Exception:
            pass

    def init_ui(self):
        self.setWindowTitle("Comic Panel Extractor")
        # Calcul dynamique du format A4 selon l'écran
        screen = QGuiApplication.primaryScreen()
        screen_geometry = screen.availableGeometry()
        initial_height = min(1000, max(480, screen_geometry.height() - 160))
        a4_ratio = 1 / 1.414  # ≈ 0.707
        initial_width = int(initial_height * a4_ratio)
        self.setMinimumSize(360, 480)
        self.resize(initial_width, initial_height)
        self.create_menu()

        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QHBoxLayout(central_widget)

        # Zone de gauche (page complète)
        left_widget = QWidget()
        left_layout = QVBoxLayout(left_widget)

        self.page_viewer = QLabel()
        self.page_viewer.setMinimumSize(QSize(280, 360))
        self.page_viewer.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.page_viewer.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        left_layout.addWidget(self.page_viewer)

        nav_layout = QHBoxLayout()
        self.prev_page_btn = QPushButton("Page précédente")
        self.next_page_btn = QPushButton("Page suivante")
        self.page_label = QLabel("Page 0/0")
        nav_layout.addWidget(self.prev_page_btn)
        nav_layout.addWidget(self.page_label)
        nav_layout.addWidget(self.next_page_btn)
        left_layout.addLayout(nav_layout)

        count_layout = QHBoxLayout()
        self.found_panel_count_label = QLabel("Cases trouvées : 0")
        self.expected_panel_count_spin = QSpinBox()
        self.expected_panel_count_spin.setRange(0, 500)
        self.expected_panel_count_spin.setKeyboardTracking(False)
        self.expected_panel_count_spin.setToolTip(
            "Nombre de cases attendu. Modifiez cette valeur pour relancer "
            "la détection de la page."
        )
        count_layout.addWidget(self.found_panel_count_label)
        count_layout.addWidget(QLabel("Attendu :"))
        count_layout.addWidget(self.expected_panel_count_spin)
        count_layout.addStretch()
        left_layout.addLayout(count_layout)
        self.expected_panel_count_spin.valueChanged.connect(self.adjust_panel_count)

        edit_layout = QHBoxLayout()
        self.update_btn = QPushButton("Update")
        self.save_panels_btn = QPushButton("Save")
        self.save_sample_btn = QPushButton("Save Sample")
        self.save_sample_btn.setEnabled(False)
        edit_layout.addWidget(self.update_btn)
        edit_layout.addWidget(self.save_panels_btn)
        edit_layout.addWidget(self.save_sample_btn)
        left_layout.addLayout(edit_layout)
        self.update_btn.clicked.connect(self.update_panels)
        self.save_panels_btn.clicked.connect(self.save_panel_training)
        self.save_sample_btn.clicked.connect(self.save_panel_sample)

        main_layout.addWidget(left_widget)

        self.prev_page_btn.clicked.connect(self.previous_page)
        self.next_page_btn.clicked.connect(self.next_page)

        # Status bar pour afficher les coordonnées
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.coord_label = QLabel("Coordonnées : ")
        self.status_bar.addPermanentWidget(self.coord_label)

        # Ajoute la gestion du clic pour échanger deux cases
        self.page_viewer.setMouseTracking(True)
        self.page_viewer.mouseMoveEvent = self.show_panel_coords
        self.page_viewer.mousePressEvent = self.handle_panel_click
        self.page_viewer.mouseReleaseEvent = self.handle_panel_release

    def create_menu(self):
        menubar = self.menuBar()
        file_menu = menubar.addMenu('Fichier')
        open_action = QAction('Ouvrir...', self)
        open_action.setShortcut('Ctrl+O')
        open_action.triggered.connect(self.open_file)
        save_action = QAction('Sauvegarder CBZ...', self)
        save_action.setShortcut('Ctrl+S')
        save_action.triggered.connect(self.save_cbz)
        file_menu.addAction(open_action)
        file_menu.addAction(save_action)

        # Menu Options
        options_menu = menubar.addMenu('Options')

        input_action = QAction("Définir dossier d'input...", self)
        input_action.triggered.connect(self.set_input_dir)
        options_menu.addAction(input_action)

        output_action = QAction("Définir dossier d'output...", self)
        output_action.triggered.connect(self.set_output_dir)
        options_menu.addAction(output_action)

        # Mode couleur
        color_menu = options_menu.addMenu("Mode couleur")
        color_system = QAction("Système", self, checkable=True)
        color_light = QAction("Clair", self, checkable=True)
        color_dark = QAction("Sombre", self, checkable=True)
        color_group = QActionGroup(self)
        for act in (color_system, color_light, color_dark):
            color_group.addAction(act)
            color_menu.addAction(act)
        color_system.setChecked(True)

        color_system.triggered.connect(lambda: self.set_color_mode("système"))
        color_light.triggered.connect(lambda: self.set_color_mode("clair"))
        color_dark.triggered.connect(lambda: self.set_color_mode("sombre"))

        # Menu E-reader
        e_reader_menu = options_menu.addMenu("E-reader output")
        for model, res in E_READERS.items():
            action = QAction(f"{model} ({res[0]}x{res[1]})", self, checkable=True)
            action.triggered.connect(lambda checked, m=model, r=res: self.set_e_reader(m, r))
            e_reader_menu.addAction(action)
            # Coche si déjà sélectionné
            if self.e_reader_model == model:
                action.setChecked(True)

    def set_input_dir(self):
        dir_ = QFileDialog.getExistingDirectory(self, "Choisir le dossier d'input", self.input_dir)
        if dir_:
            self.input_dir = dir_
            self.save_config()

    def set_output_dir(self):
        dir_ = QFileDialog.getExistingDirectory(self, "Choisir le dossier d'output", self.output_dir)
        if dir_:
            self.output_dir = dir_
            self.save_config()

    def set_color_mode(self, mode):
        self.color_mode = mode
        if mode == "clair":
            self.apply_light_palette()
        elif mode == "sombre":
            self.apply_dark_palette()
        else:
            QApplication.setStyle("Fusion")
            QApplication.setPalette(QApplication.style().standardPalette())
        self.save_config()

    def set_e_reader(self, model, resolution):
        self.e_reader_model = model
        self.e_reader_resolution = resolution
        self.save_config()
        QMessageBox.information(
            self,
            "E-reader sélectionné",
            f"Modèle : {model}\nRésolution : {resolution[0]} x {resolution[1]}"
        )
        
    def apply_light_palette(self):
        app = QApplication.instance()
        app.setStyle("Fusion")
        palette = app.palette()
        palette.setColor(QPalette.ColorRole.Window, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.WindowText, QColor(0, 0, 0))
        palette.setColor(QPalette.ColorRole.Base, QColor(245, 245, 245))
        palette.setColor(QPalette.ColorRole.AlternateBase, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(0, 0, 0))
        palette.setColor(QPalette.ColorRole.ToolTipText, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.Text, QColor(0, 0, 0))
        palette.setColor(QPalette.ColorRole.Button, QColor(230, 230, 230))
        palette.setColor(QPalette.ColorRole.ButtonText, QColor(0, 0, 0))
        palette.setColor(QPalette.ColorRole.BrightText, QColor(255, 0, 0))
        palette.setColor(QPalette.ColorRole.Link, QColor(42, 130, 218))
        palette.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
        palette.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
        app.setPalette(palette)

    def apply_dark_palette(self):
        app = QApplication.instance()
        app.setStyle("Fusion")
        palette = app.palette()
        palette.setColor(QPalette.ColorRole.Window, QColor(53, 53, 53))
        palette.setColor(QPalette.ColorRole.WindowText, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
        palette.setColor(QPalette.ColorRole.AlternateBase, QColor(53, 53, 53))
        palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.ToolTipText, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.Text, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.Button, QColor(53, 53, 53))
        palette.setColor(QPalette.ColorRole.ButtonText, QColor(255, 255, 255))
        palette.setColor(QPalette.ColorRole.BrightText, QColor(255, 0, 0))
        palette.setColor(QPalette.ColorRole.Link, QColor(42, 130, 218))
        palette.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
        palette.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
        app.setPalette(palette)

    def load_panel_training(self):
        if not os.path.exists(self.PANEL_TRAINING_PATH):
            return {}
        with open(self.PANEL_TRAINING_PATH, "r", encoding="utf-8") as training_file:
            training_data = json.load(training_file)
        if not isinstance(training_data, dict) or not isinstance(
            training_data.get("pages", {}),
            dict,
        ):
            raise ValueError("Le fichier d'apprentissage des cases est invalide.")
        pages = {}
        for page_id, raw_entry in training_data["pages"].items():
            if isinstance(raw_entry, list):
                entry = {
                    "boxes": raw_entry,
                    "samples": [],
                    "group": page_id,
                }
            elif isinstance(raw_entry, dict):
                entry = {
                    "boxes": raw_entry.get("boxes"),
                    "samples": raw_entry.get("samples", []),
                    "group": raw_entry.get("group", page_id),
                    "detected_boxes": raw_entry.get("detected_boxes"),
                }
            else:
                raise ValueError("Un exemple de page est invalide.")
            if not isinstance(entry["boxes"], list) or not isinstance(
                entry["samples"],
                list,
            ) or not isinstance(entry.get("group"), str):
                raise ValueError("Un exemple de page est invalide.")
            if entry.get("detected_boxes") is not None and not isinstance(
                entry["detected_boxes"],
                list,
            ):
                raise ValueError("Les détections initiales d'une page sont invalides.")
            for sample in entry["samples"]:
                if (
                    not isinstance(sample, dict)
                    or sample.get("label") not in (0, 1)
                    or not isinstance(sample.get("features"), list)
                    or len(sample["features"]) != PanelLearningModel.FEATURE_COUNT
                    or not all(
                        isinstance(value, (int, float))
                        and np.isfinite(value)
                        for value in sample["features"]
                    )
                ):
                    raise ValueError("Un exemple d'apprentissage est invalide.")
            pages[page_id] = entry
        return pages

    @staticmethod
    def _page_signature(image: np.ndarray) -> str:
        digest = hashlib.sha256()
        digest.update(str(image.shape).encode("ascii"))
        digest.update(image.tobytes())
        return digest.hexdigest()

    def _comic_signature(self) -> str:
        source_path = self.file_handler.current_file
        if not source_path:
            raise ValueError("Aucune bande dessinée n'est actuellement ouverte.")
        normalized_path = os.path.normcase(os.path.abspath(source_path))
        return hashlib.sha256(normalized_path.encode("utf-8")).hexdigest()

    def _panels_from_saved_annotations(
        self,
        image: np.ndarray,
        annotations,
    ) -> List[Panel]:
        page_height, page_width = image.shape[:2]
        panels = []
        for box in annotations:
            if not isinstance(box, list) or len(box) != 4:
                raise ValueError("Une découpe sauvegardée a un format invalide.")
            x, y, width, height = (int(value) for value in box)
            if (
                x < 0
                or y < 0
                or width <= 0
                or height <= 0
                or x + width > page_width
                or y + height > page_height
            ):
                raise ValueError("Une découpe sauvegardée sort des limites de sa page.")
            panels.append(
                Panel(
                    x,
                    y,
                    width,
                    height,
                    image[y:y + height, x:x + width],
                    1.0,
                )
            )
        return panels

    @staticmethod
    def _panel_intersection_over_union(first, second) -> float:
        first_x, first_y, first_width, first_height = first
        second_x, second_y, second_width, second_height = second
        intersection_width = max(
            0,
            min(first_x + first_width, second_x + second_width)
            - max(first_x, second_x),
        )
        intersection_height = max(
            0,
            min(first_y + first_height, second_y + second_height)
            - max(first_y, second_y),
        )
        intersection = intersection_width * intersection_height
        union = (
            first_width * first_height
            + second_width * second_height
            - intersection
        )
        return intersection / union if union else 0.0

    @staticmethod
    def _boxes_from_sample_overlay(image, color):
        page_height, page_width = image.shape[:2]
        min_width, min_height = minimum_panel_dimensions(
            page_width,
            page_height,
        )
        mask = np.uint8(np.all(image == color, axis=2)) * 255
        horizontal_lines = cv2.morphologyEx(
            mask,
            cv2.MORPH_OPEN,
            np.ones((1, min_width), dtype=np.uint8),
        )
        component_count, _, stats, _ = cv2.connectedComponentsWithStats(
            horizontal_lines,
        )
        segments = sorted(
            (
                (int(x), int(y), int(width), int(height))
                for x, y, width, height, area in stats[1:component_count]
                if area > 0
            ),
            key=lambda segment: (segment[1], segment[0]),
        )

        boxes = []
        edge_tolerance = 25
        for index, (x, y, width, height) in enumerate(segments):
            for next_x, next_y, next_width, next_height in segments[index + 1:]:
                if next_y <= y + height + min_height:
                    continue
                if (
                    abs(x - next_x) > edge_tolerance
                    or abs(x + width - next_x - next_width) > edge_tolerance
                ):
                    continue

                left = round((x + next_x) / 2)
                right = round(
                    (x + width + next_x + next_width) / 2
                )
                top = y
                bottom = next_y + next_height
                if (
                    right - left < min_width
                    or bottom - top < min_height
                ):
                    continue

                edge_bands = (
                    mask[max(0, top - 8):min(page_height, top + 9), left:right],
                    mask[
                        max(0, bottom - 8):min(page_height, bottom + 9),
                        left:right,
                    ],
                    mask[
                        top:bottom,
                        max(0, left - 12):min(page_width, left + 13),
                    ],
                    mask[
                        top:bottom,
                        max(0, right - 12):min(page_width, right + 13),
                    ],
                )
                edge_coverage = [
                    np.count_nonzero(band) / max(band.size, 1)
                    for band in edge_bands
                ]
                if min(edge_coverage) < 0.3:
                    continue

                candidate = (left, top, right - left, bottom - top)
                if any(
                    MainWindow._panel_intersection_over_union(
                        candidate,
                        existing,
                    ) >= 0.9
                    for existing in boxes
                ):
                    continue
                boxes.append(candidate)

        return sorted(boxes, key=lambda box: (box[1], box[0]))

    def _training_samples_for_page(
        self,
        image,
        corrected_boxes,
        candidate_boxes=None,
    ):
        samples = [
            {
                "features": PanelLearningModel.features(image, box),
                "label": 1,
            }
            for box in corrected_boxes
        ]
        if candidate_boxes is None:
            candidate_boxes = self._panel_boxes(
                self.panel_detector.detect_panels(image)
            )
        for candidate_box in candidate_boxes:
            overlaps = [
                self._panel_intersection_over_union(candidate_box, box)
                for box in corrected_boxes
            ]
            overlap = max(overlaps, default=0.0)
            if overlap >= 0.5:
                label = 1
            elif overlap <= 0.1 or sum(value >= 0.1 for value in overlaps) >= 2:
                label = 0
            else:
                continue
            samples.append(
                {
                    "features": PanelLearningModel.features(
                        image,
                        candidate_box,
                    ),
                    "label": label,
                }
            )
        return samples

    def _load_sample_training_examples(self, existing_examples):
        sample_pattern = re.compile(
            r"(?P<comic>.+)_page_(?P<page>\d+)_"
            r"(?P<timestamp>\d{8}_\d{6}_\d+)_original\.png"
        )
        latest_samples = {}
        for original_path in Path(self.SAMPLE_DIRECTORY).glob("*_original.png"):
            match = sample_pattern.fullmatch(original_path.name)
            if match is None:
                continue
            sample_key = (match.group("comic"), match.group("page"))
            previous = latest_samples.get(sample_key)
            if previous is None or match.group("timestamp") > previous[0]:
                latest_samples[sample_key] = (
                    match.group("timestamp"),
                    original_path,
                    match.group("comic"),
                )

        examples = dict(existing_examples)
        for _, original_path, comic_name in sorted(
            latest_samples.values(),
            key=lambda sample: (sample[2], sample[0]),
        ):
            stem = original_path.name.removesuffix("_original.png")
            detected_path = original_path.with_name(f"{stem}_detected.png")
            corrected_path = original_path.with_name(f"{stem}_corrected.png")
            original = cv2.imread(str(original_path))
            detected = cv2.imread(str(detected_path))
            corrected = cv2.imread(str(corrected_path))
            if original is None or detected is None or corrected is None:
                raise ValueError(
                    f"Triplet d'échantillon incomplet ou illisible : {stem}"
                )
            if (
                detected.shape != original.shape
                or corrected.shape != original.shape
            ):
                raise ValueError(
                    f"Les dimensions du triplet d'échantillon diffèrent : {stem}"
                )

            signature = self._page_signature(original)
            if signature in existing_examples:
                continue
            detected_boxes = self._boxes_from_sample_overlay(
                detected,
                (255, 80, 0),
            )
            corrected_boxes = self._boxes_from_sample_overlay(
                corrected,
                (0, 200, 0),
            )
            examples[signature] = {
                "boxes": [list(box) for box in corrected_boxes],
                "samples": self._training_samples_for_page(
                    original,
                    corrected_boxes,
                    detected_boxes,
                ),
                "group": f"sample:{comic_name}",
                "detected_boxes": [list(box) for box in detected_boxes],
            }

        return examples

    def _refresh_pages_with_learned_model(self) -> None:
        if self.panel_learning_model.parameters is None:
            return
        for page_idx in range(self.total_pages):
            page_image = self.file_handler.get_page(page_idx)
            signature = self._page_signature(page_image)
            if page_idx in self.modified_page_indices:
                continue
            saved_example = self.training_examples.get(signature)
            if saved_example is not None:
                panels = self._panels_from_saved_annotations(
                    page_image,
                    saved_example["boxes"],
                )
            elif page_idx < 2:
                continue
            else:
                panels = self.panel_detector.detect_panels(page_image)
                panels = self.panel_learning_model.filter_panels(
                    page_image,
                    panels,
                )
                self.expected_panel_counts[page_idx] = len(panels)
            self.panels_by_page[page_idx] = (
                self.panel_detector._group_panels_into_rows(panels)
            )
            self._set_detected_boxes(page_idx, self._panel_boxes(panels))

    def open_file(self):
        default_path = r"C:\Users\miche\OneDrive\Books\BD- Eternum INT 3T cbr\BD- Eternum T03-iBooker.cbz"
        file_name, _ = QFileDialog.getOpenFileName(
            self,
            "Ouvrir un fichier",
            self.input_dir,
            "Comics (*.cbz *.cbr *.pdf *.zip *.rar);;Tous les fichiers (*.*)"  # MODIFIÉ : Ajout CBR et RAR
        )
        if file_name:
            try:
                self._clear_panel_edit_state()
                self.edit_mode = False
                self.update_btn.setText("Update")
                self.training_examples = self._load_sample_training_examples(
                    self.load_panel_training()
                )
                self.panel_learning_model = PanelLearningModel()
                self.panel_learning_model.fit(self.training_examples)
                self.total_pages = self.file_handler.open_file(file_name)
                self.current_page = 0
                self.panels_by_page = []
                self.expected_panel_counts = {}
                self.modified_page_indices = set()
                self.detected_boxes_by_page = []
                self.save_sample_btn.setEnabled(False)

                # Ajout de la jauge de progression
                progress = QProgressDialog("Chargement des pages...", "Annuler", 0, self.total_pages, self)
                progress.setWindowTitle("Chargement")
                progress.setWindowModality(Qt.WindowModality.ApplicationModal)
                progress.setMinimumDuration(0)
                progress.setValue(0)

                for page_idx in range(self.total_pages):
                    if progress.wasCanceled():
                        self.coord_label.setText("Chargement annulé")
                        return
                    self.coord_label.setText(f"Traitement page {page_idx + 1}/{self.total_pages}")
                    QApplication.processEvents()
                    page_img = self.file_handler.get_page(page_idx)
                    page_signature = self._page_signature(page_img)
                    saved_example = self.training_examples.get(page_signature)
                    if page_idx < 2:
                        detected_panels = []
                    else:
                        detected_panels = self.panel_detector.detect_panels(page_img)
                        detected_panels = self.panel_learning_model.filter_panels(
                            page_img,
                            detected_panels,
                        )
                    if (
                        saved_example is not None
                        and saved_example.get("detected_boxes") is not None
                    ):
                        detected_boxes = saved_example["detected_boxes"]
                    else:
                        detected_boxes = self._panel_boxes(detected_panels)
                    self.detected_boxes_by_page.append(detected_boxes)
                    if saved_example is not None:
                        panels = self._panels_from_saved_annotations(
                            page_img,
                            saved_example["boxes"],
                        )
                    elif page_idx < 2:
                        panels = []
                    else:
                        panels = detected_panels
                    rows = self.panel_detector._group_panels_into_rows(panels)
                    self.panels_by_page.append(rows)
                    self.expected_panel_counts[page_idx] = len(panels)
                    progress.setValue(page_idx + 1)
                progress.close()
                if self.panel_learning_model.parameters is not None:
                    self.coord_label.setText(
                        "Ouverture terminée — apprentissage inter-BD actif "
                        f"(validation {self.panel_learning_model.validation_score:.0%})"
                    )
                else:
                    self.coord_label.setText(
                        "Ouverture terminée — détection standard "
                        "(apprentissage inter-BD non activé)"
                    )
                self.load_current_page()
                self.setWindowTitle(f"Comic Panel Extractor - {os.path.basename(file_name)}")
                self.save_sample_btn.setEnabled(True)
            except Exception as e:
                QMessageBox.critical(self, "Erreur", f"Erreur lors de l'ouverture du fichier: {str(e)}")

    def load_current_page(self):
        if 0 <= self.current_page < self.total_pages:
            page_img = self.file_handler.get_page(self.current_page)
            height, width = page_img.shape[:2]

            # panels_by_page contient déjà la structure par lignes
            rows = self.panels_by_page[self.current_page]
            panels = [p for row in rows for p in row]
            self.found_panel_count_label.setText(
                f"Cases trouvées : {len(panels)}"
            )
            expected_count = self.expected_panel_counts.setdefault(
                self.current_page,
                len(panels),
            )
            previous_block_state = self.expected_panel_count_spin.blockSignals(True)
            self.expected_panel_count_spin.setValue(expected_count)
            self.expected_panel_count_spin.blockSignals(previous_block_state)

            # Afficher la page avec numérotation
            rgb_img = cv2.cvtColor(page_img, cv2.COLOR_BGR2RGB)
            qimg = QImage(rgb_img.data, width, height, width * 3, QImage.Format.Format_RGB888)
            pixmap = QPixmap.fromImage(qimg)

            painter = QPainter(pixmap)
            painter.setPen(QPen(QColor(255, 0, 0), 4))

            from string import ascii_uppercase
            font = QFont()
            font_size = max(18, height // 25)
            font.setPointSize(font_size)
            painter.setFont(font)

            for row_idx, row in enumerate(rows):
                letter = ascii_uppercase[row_idx % 26]
                for col_idx, p in enumerate(row):
                    x, y = p.x + 10, p.y + 30
                    painter.drawText(x, y, f"{letter}{col_idx + 1}")

            # Afficher les lignes détectées
            # Ligne orange épaisse et continue
            painter.setPen(QPen(QColor(255, 140, 0), 8, Qt.PenStyle.SolidLine))
            for row in rows:
                min_x = min(p.x for p in row)
                max_x = max(p.x + p.width for p in row)
                min_y = min(p.y for p in row)
                max_y = max(p.y + p.height for p in row)
                painter.drawRect(min_x, min_y, max_x - min_x, max_y - min_y)
            # Couleurs et style pour les lignes de regroupement
            painter.setPen(QPen(QColor(255, 255, 0), 6, Qt.PenStyle.DashLine))  # Jaune fluo, pointillé, épais
            font_letter = QFont()
            font_letter.setPointSize(max(32, height // 18))
            font_letter.setBold(True)
            painter.setFont(font_letter)

            for i, row in enumerate(rows):
                min_x = min(p.x for p in row)
                max_x = max(p.x + p.width for p in row)
                min_y = min(p.y for p in row)
                max_y = max(p.y + p.height for p in row)
                painter.drawRect(min_x, min_y, max_x - min_x, max_y - min_y)
                # Lettre de ligne (A, B, C, ...)
                letter = ascii_uppercase[i % 26]
                painter.drawText(min_x + 10, min_y + 40, letter)

            # Chaque case détectée est exportée comme une page distincte.
            painter.setPen(QPen(QColor(0, 120, 255), 10, Qt.PenStyle.SolidLine))
            for panel in panels:
                painter.drawRect(panel.x, panel.y, panel.width, panel.height)

            if any(panel is self.selected_panel for panel in panels):
                painter.setPen(QPen(QColor(255, 255, 0), 12, Qt.PenStyle.SolidLine))
                painter.drawRect(
                    self.selected_panel.x,
                    self.selected_panel.y,
                    self.selected_panel.width,
                    self.selected_panel.height,
                )
            if self.drag_start and self.drag_current:
                x1, y1 = self.drag_start
                x2, y2 = self.drag_current
                painter.setPen(QPen(QColor(0, 255, 0), 10, Qt.PenStyle.DashLine))
                painter.drawRect(
                    min(x1, x2),
                    min(y1, y2),
                    abs(x2 - x1),
                    abs(y2 - y1),
                )

            painter.end()

            # Affichage au format A4 (rapport 1/√2 ≈ 0.707)
            viewer_width = self.page_viewer.width()
            viewer_height = self.page_viewer.height()

            if self.e_reader_resolution:
                target_width, target_height = self.e_reader_resolution
                ereader_ratio = target_width / target_height
                # On adapte la taille à la zone d'affichage tout en gardant le ratio e-reader
                if viewer_width / viewer_height > ereader_ratio:
                    # Zone d'affichage plus large que l'e-reader : on limite par la hauteur
                    scaled_height = min(viewer_height, target_height)
                    scaled_width = int(scaled_height * ereader_ratio)
                else:
                    # Zone d'affichage plus haute que l'e-reader : on limite par la largeur
                    scaled_width = min(viewer_width, target_width)
                    scaled_height = int(scaled_width / ereader_ratio)
                target_size = QSize(scaled_width, scaled_height)
            else:
                a4_ratio = 1 / 1.414  # ≈ 0.707
                screen = QGuiApplication.primaryScreen()
                screen_geometry = screen.availableGeometry()
                max_height = screen_geometry.height() - 80
                target_height = min(viewer_height, max_height)
                target_width = int(target_height * a4_ratio)
                target_size = QSize(target_width, target_height)

            scaled_pixmap = pixmap.scaled(
                target_size,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation
            )
            self.page_viewer.setPixmap(scaled_pixmap)
            self.page_viewer.repaint()

            self.page_label.setText(f"Page {self.current_page + 1}/{self.total_pages}")
            self.status_bar.showMessage(f"Page {self.current_page + 1}/{self.total_pages}")

            # Affiche dans le terminal les numéros des cases par ligne
            print(f"Lignes détectées pour la page {self.current_page + 1} :")
            for i, row in enumerate(rows):
                min_x = min(p.x for p in row)
                min_y = min(p.y for p in row)
                max_x = max(p.x + p.width for p in row)
                max_y = max(p.y + p.height for p in row)
                cases_str = [
                    f"({p.x},{p.y})-({p.x + p.width},{p.y + p.height})"
                    for p in row
                ]
                print(
                    f"  Ligne {i+1}: ({min_x},{min_y})-({max_x},{max_y}) "
                    f"cases: {cases_str}"
                )

           # print(f"Coordonnées des cases pour la page {self.current_page + 1} :")
           # for idx, panel in enumerate(panels):
           #     x1, y1 = panel.x, panel.y
           #     x2, y2 = panel.x + panel.width, panel.y + panel.height
           #     print(f"  Case {idx+1}: haut/gauche=({x1},{y1}), bas/droite=({x2},{y2})")

    def previous_page(self):
        if self.current_page > 0:
            self.current_page -= 1
            self._clear_panel_edit_state()
            self.load_current_page()

    def next_page(self):
        if self.current_page < self.total_pages - 1:
            self.current_page += 1
            self._clear_panel_edit_state()
            self.load_current_page()

    def _clear_panel_edit_state(self):
        self.selected_panel = None
        self.selected_panel_idx = None
        self.drag_start = None
        self.drag_current = None
        self.resize_edges = None
        self.resize_start_bounds = None

    @staticmethod
    def _panel_boxes(panels: List[Panel]) -> List[List[int]]:
        return [
            [panel.x, panel.y, panel.width, panel.height]
            for panel in panels
        ]

    def _set_detected_boxes(self, page_idx: int, boxes: List[List[int]]) -> None:
        while len(self.detected_boxes_by_page) <= page_idx:
            self.detected_boxes_by_page.append([])
        self.detected_boxes_by_page[page_idx] = boxes

    def adjust_panel_count(self, desired_count: int) -> None:
        if not self.panels_by_page or self.current_page >= self.total_pages:
            return
        page_image = self.file_handler.get_page(self.current_page)
        try:
            self.expected_panel_counts[self.current_page] = desired_count
            panels = self.panel_detector.detect_panels_for_count(
                page_image,
                desired_count,
                candidate_filter=lambda candidates: (
                    self.panel_learning_model.filter_panels(
                        page_image,
                        candidates,
                    )
                ),
            )
            self._set_detected_boxes(
                self.current_page,
                self._panel_boxes(panels),
            )
            self._set_current_panels(panels)
            self.modified_page_indices.add(self.current_page)
            actual_count = len(panels)
            self.load_current_page()
            if actual_count == desired_count:
                self.status_bar.showMessage(
                    f"{actual_count} cases trouvées (nombre demandé atteint).",
                    5000,
                )
            else:
                self.status_bar.showMessage(
                    f"{actual_count} cases trouvées ; {desired_count} demandées, "
                    "meilleur résultat de la détection.",
                    7000,
                )
        except Exception as error:
            self.expected_panel_counts.pop(self.current_page, None)
            previous_block_state = self.expected_panel_count_spin.blockSignals(True)
            self.expected_panel_count_spin.setValue(
                len(self._current_panels())
            )
            self.expected_panel_count_spin.blockSignals(previous_block_state)
            QMessageBox.critical(
                self,
                "Erreur de détection",
                f"Impossible d'ajuster le nombre de cases : {error}",
            )

    def _current_panels(self) -> List[Panel]:
        return [
            panel
            for row in self.panels_by_page[self.current_page]
            for panel in row
        ]

    def _set_current_panels(self, panels: List[Panel]) -> None:
        self.panels_by_page[self.current_page] = (
            self.panel_detector._group_panels_into_rows(panels)
        )

    def _mark_current_page_modified(self) -> None:
        self.modified_page_indices.add(self.current_page)

    def update_panels(self):
        self.edit_mode = not self.edit_mode
        self.selected_panel = None
        self.selected_panel_idx = None
        self.drag_start = None
        self.drag_current = None
        self.resize_edges = None
        self.resize_start_bounds = None
        self.update_btn.setText(
            "Terminer modification" if self.edit_mode else "Update"
        )
        self.coord_label.setText(
            "Glisser pour ajouter; tirer un bord pour redimensionner; "
            "sélectionner puis Suppr pour supprimer."
            if self.edit_mode
            else "Coordonnées : "
        )
        self.load_current_page()

    @staticmethod
    def _encode_png(image: np.ndarray) -> bytes:
        success, encoded = cv2.imencode(".png", image)
        if not success:
            raise RuntimeError("Impossible de convertir l'image en PNG.")
        return encoded.tobytes()

    @classmethod
    def _build_panel_sample_files(
        cls,
        image: np.ndarray,
        detected_boxes: List[List[int]],
        corrected_boxes: List[List[int]],
    ) -> dict:
        def annotated_image(boxes, color):
            result = image.copy()
            for index, (x, y, width, height) in enumerate(boxes, start=1):
                cv2.rectangle(
                    result,
                    (x, y),
                    (x + width, y + height),
                    color,
                    max(2, min(image.shape[:2]) // 500),
                )
                cv2.putText(
                    result,
                    str(index),
                    (x + 8, y + 28),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    max(0.6, min(image.shape[:2]) / 1000),
                    color,
                    2,
                    cv2.LINE_AA,
                )
            return result

        return {
            "original": cls._encode_png(image),
            "detected": cls._encode_png(
                annotated_image(detected_boxes, (255, 80, 0))
            ),
            "corrected": cls._encode_png(
                annotated_image(corrected_boxes, (0, 200, 0))
            ),
        }

    def save_panel_sample(self):
        if (
            not self.panels_by_page
            or self.current_page >= self.total_pages
            or self.current_page >= len(self.detected_boxes_by_page)
        ):
            QMessageBox.warning(
                self,
                "Attention",
                "Aucune page prête à être enregistrée comme échantillon.",
            )
            return

        source_name = os.path.basename(self.file_handler.current_file or "comic")
        page_number = self.current_page + 1
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        sample_name = f"{Path(source_name).stem}_page_{page_number:04d}_{timestamp}"
        temporary_paths = []
        try:
            image = self.file_handler.get_page(self.current_page)
            sample_files = self._build_panel_sample_files(
                image,
                self.detected_boxes_by_page[self.current_page],
                self._panel_boxes(self._current_panels()),
            )
            os.makedirs(self.SAMPLE_DIRECTORY, exist_ok=True)
            for image_kind, content in sample_files.items():
                with tempfile.NamedTemporaryFile(
                    dir=self.SAMPLE_DIRECTORY,
                    prefix=".panel-sample-",
                    suffix=".png",
                    delete=False,
                ) as temporary_file:
                    temporary_file.write(content)
                    temporary_paths.append(
                        (
                            temporary_file.name,
                            os.path.join(
                                self.SAMPLE_DIRECTORY,
                                f"{sample_name}_{image_kind}.png",
                            ),
                        )
                    )
            for temporary_path, output_path in temporary_paths:
                os.replace(temporary_path, output_path)
            temporary_paths.clear()
        except (OSError, ValueError, RuntimeError, cv2.error) as error:
            QMessageBox.critical(
                self,
                "Erreur",
                f"Impossible d'enregistrer les trois images dans "
                f"{self.SAMPLE_DIRECTORY} : {error}",
            )
            return
        finally:
            for temporary_path, _ in temporary_paths:
                if not os.path.exists(temporary_path):
                    continue
                try:
                    os.remove(temporary_path)
                except OSError as error:
                    QMessageBox.critical(
                        self,
                        "Erreur",
                        f"Impossible de supprimer le fichier temporaire : {error}",
                    )

        QMessageBox.information(
            self,
            "Échantillon enregistré",
            f"Les trois images (originale, détection, correction) ont été "
            f"enregistrées séparément dans :\n{self.SAMPLE_DIRECTORY}",
        )

    def save_panel_training(self):
        if not self.panels_by_page or self.current_page >= self.total_pages:
            QMessageBox.warning(self, "Attention", "Aucune page à enregistrer")
            return
        temp_path = None
        try:
            examples = self._load_sample_training_examples(
                self.load_panel_training()
            )
            page_image = self.file_handler.get_page(self.current_page)
            signature = self._page_signature(page_image)
            boxes = self._panel_boxes(self._current_panels())
            examples[signature] = {
                "boxes": boxes,
                "samples": self._training_samples_for_page(page_image, boxes),
                "group": self._comic_signature(),
                "detected_boxes": self.detected_boxes_by_page[
                    self.current_page
                ],
            }
            parent_dir = os.path.dirname(self.PANEL_TRAINING_PATH)
            os.makedirs(parent_dir, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=parent_dir,
                prefix=".bdsplit-panel-training-",
                suffix=".tmp",
                delete=False,
            ) as training_file:
                temp_path = training_file.name
                json.dump(
                    {"version": 2, "pages": examples},
                    training_file,
                    indent=2,
                )
            os.replace(temp_path, self.PANEL_TRAINING_PATH)
            temp_path = None
        except (OSError, ValueError, json.JSONDecodeError) as error:
            QMessageBox.critical(
                self,
                "Erreur",
                f"Impossible d'enregistrer les découpes : {error}",
            )
            return
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError as error:
                    QMessageBox.critical(
                        self,
                        "Erreur",
                        f"Impossible de supprimer le fichier temporaire "
                        f"{temp_path} : {error}",
                    )
        self.training_examples = examples
        self.modified_page_indices.discard(self.current_page)
        model_is_active = self.panel_learning_model.fit(examples)
        try:
            self._refresh_pages_with_learned_model()
        except (OSError, ValueError, cv2.error) as error:
            QMessageBox.critical(
                self,
                "Actualisation incomplète",
                "Les corrections sont enregistrées, mais les autres pages "
                f"n'ont pas pu être redétectées : {error}",
            )
        if model_is_active:
            learning_status = (
                " Le modèle appris est actif et les autres pages non corrigées "
                "ont été redétectées avec lui "
                f"(validation par page : "
                f"{self.panel_learning_model.validation_score:.0%})."
            )
        else:
            learning_status = (
                " Le modèle attend au moins trois pages avec des exemples "
                "positifs et négatifs, et une validation fiable ; "
                "la détection standard reste utilisée jusque-là."
            )
        QMessageBox.information(
            self,
            "Cases enregistrées",
            "Les corrections sont enregistrées et seront réutilisées pour "
            "cette page." + learning_status,
        )

    def keyPressEvent(self, event):
        if (
            self.edit_mode
            and event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace)
            and self.selected_panel is not None
        ):
            panels = [
                panel
                for panel in self._current_panels()
                if panel is not self.selected_panel
            ]
            self._set_current_panels(panels)
            self._mark_current_page_modified()
            self.selected_panel = None
            self.load_current_page()
            return
        super().keyPressEvent(event)

    def _event_to_page_point(self, event, clamp=False):
        if not self.total_pages:
            return None
        page_image = self.file_handler.get_page(self.current_page)
        page_height, page_width = page_image.shape[:2]
        pixmap = self.page_viewer.pixmap()
        if pixmap is None or not pixmap.width() or not pixmap.height():
            return None
        label_width = self.page_viewer.width()
        label_height = self.page_viewer.height()
        scale_x = pixmap.width() / page_width
        scale_y = pixmap.height() / page_height
        offset_x = (label_width - pixmap.width()) // 2
        offset_y = (label_height - pixmap.height()) // 2
        x = event.position().x() if hasattr(event, "position") else event.x()
        y = event.position().y() if hasattr(event, "position") else event.y()
        if not clamp and not (
            offset_x <= x <= offset_x + pixmap.width()
            and offset_y <= y <= offset_y + pixmap.height()
        ):
            return None
        page_x = int((x - offset_x) / scale_x)
        page_y = int((y - offset_y) / scale_y)
        if clamp:
            page_x = min(max(page_x, 0), page_width)
            page_y = min(max(page_y, 0), page_height)
        return page_x, page_y

    def save_cbz(self):
        if not self.panels_by_page:
            QMessageBox.warning(self, "Attention", "Aucune page à sauvegarder")
            return
        file_name, _ = QFileDialog.getSaveFileName(
            self,
            "Sauvegarder CBZ",
            self.output_dir,
            "Comics (*.cbz)"
        )
        if file_name:
            try:
                # Jauge de progression pour la sauvegarde
                total = sum(len(row) for rows in self.panels_by_page for row in rows) + self.total_pages
                progress = QProgressDialog("Sauvegarde en cours...", "Annuler", 0, total, self)
                progress.setWindowTitle("Sauvegarde")
                progress.setWindowModality(Qt.WindowModality.ApplicationModal)
                progress.setMinimumDuration(0)
                progress.setValue(0)
                count = 0

                def progress_callback():
                    nonlocal count
                    count += 1
                    progress.setValue(count)
                    QApplication.processEvents()
                    if progress.wasCanceled():
                        raise Exception("Sauvegarde annulée")

                self.file_handler.save_cbz(file_name, self.panels_by_page, self.e_reader_resolution, progress_callback)
                progress.close()
                QMessageBox.information(self, "Succès", "Fichier CBZ sauvegardé avec succès!")
            except Exception as e:
                QMessageBox.critical(self, "Erreur", f"Erreur lors de la sauvegarde: {str(e)}")

    def closeEvent(self, event):
        self.file_handler.cleanup()
        super().closeEvent(event)
    
    def handle_panel_click(self, event):
        if event.button() != Qt.MouseButton.LeftButton:
            return
        self.page_viewer.setFocus()
        if not self.panels_by_page or self.current_page >= len(self.panels_by_page):
            return
        point = self._event_to_page_point(event)
        if point is None:
            return
        px, py = point
        panels = self._current_panels()
        if self.edit_mode:
            page_image = self.file_handler.get_page(self.current_page)
            pixmap = self.page_viewer.pixmap()
            if pixmap is None:
                return
            scale = min(
                pixmap.width() / page_image.shape[1],
                pixmap.height() / page_image.shape[0],
            )
            tolerance = max(8, int(12 / max(scale, 0.01)))
            for panel in panels:
                left, top = panel.x, panel.y
                right, bottom = left + panel.width, top + panel.height
                if not (
                    left - tolerance <= px <= right + tolerance
                    and top - tolerance <= py <= bottom + tolerance
                ):
                    continue
                edges = (
                    abs(px - left) <= tolerance,
                    abs(py - top) <= tolerance,
                    abs(px - right) <= tolerance,
                    abs(py - bottom) <= tolerance,
                )
                if any(edges):
                    self.selected_panel = panel
                    self.resize_edges = edges
                    self.resize_start_bounds = (
                        panel.x,
                        panel.y,
                        panel.width,
                        panel.height,
                    )
                    self.drag_start = (px, py)
                    self.drag_current = (px, py)
                    self.load_current_page()
                    return
                if left <= px <= right and top <= py <= bottom:
                    self.selected_panel = panel
                    self.load_current_page()
                    return

            self.selected_panel = None
            self.drag_start = (px, py)
            self.drag_current = (px, py)
            self.resize_edges = None
            self.resize_start_bounds = None
            self.load_current_page()
            return

        rows = self.panels_by_page[self.current_page]
        found = next(
            (
                (row_idx, col_idx)
                for row_idx, row in enumerate(rows)
                for col_idx, panel in enumerate(row)
                if panel.x <= px < panel.x + panel.width
                and panel.y <= py < panel.y + panel.height
            ),
            None,
        )
        if found is None:
            return
        row_idx, col_idx = found
        if self.selected_panel_idx is None:
            self.selected_panel_idx = (row_idx, col_idx)
        else:
            sr, sc = self.selected_panel_idx
            rows[sr][sc], rows[row_idx][col_idx] = rows[row_idx][col_idx], rows[sr][sc]
            self.selected_panel_idx = None
            self.load_current_page()

    def _resize_selected_panel(self, point):
        if not self.selected_panel or not self.resize_start_bounds:
            return
        page_image = self.file_handler.get_page(self.current_page)
        x, y, width, height = resized_panel_bounds(
            self.resize_start_bounds,
            self.resize_edges,
            point,
            page_image.shape,
        )
        right, bottom = x + width, y + height
        self.selected_panel.x = x
        self.selected_panel.y = y
        self.selected_panel.width = right - x
        self.selected_panel.height = bottom - y
        self.selected_panel.image = page_image[y:bottom, x:right]

    def handle_panel_release(self, event):
        if not self.edit_mode or self.drag_start is None:
            return
        point = self._event_to_page_point(event, clamp=True)
        if point is None:
            return
        if self.resize_edges is None:
            page_image = self.file_handler.get_page(self.current_page)
            bounds = panel_bounds_from_drag(
                self.drag_start,
                point,
                page_image.shape,
            )
            if bounds is not None:
                left, top, width, height = bounds
                panels = self._current_panels()
                panels.append(
                    Panel(
                        left,
                        top,
                        width,
                        height,
                        page_image[top:top + height, left:left + width],
                        1.0,
                    )
                )
                self._set_current_panels(panels)
                self._mark_current_page_modified()
        else:
            self._mark_current_page_modified()
        self.drag_start = None
        self.drag_current = None
        self.resize_edges = None
        self.resize_start_bounds = None
        self.load_current_page()

    def show_panel_coords(self, event):
        if self.edit_mode and self.drag_start is not None:
            point = self._event_to_page_point(event, clamp=True)
            if point is not None:
                self.drag_current = point
                if self.resize_edges is not None:
                    self._resize_selected_panel(point)
                self.load_current_page()
            return

        if not self.panels_by_page or self.current_page >= len(self.panels_by_page):
            self.coord_label.setText("Coordonnées : ")
            return
        point = self._event_to_page_point(event)
        if point is None:
            self.coord_label.setText("Coordonnées : ")
            return
        px, py = point

        rows = self.panels_by_page[self.current_page]
        from string import ascii_uppercase

        for row_idx, row in enumerate(rows):
            letter = ascii_uppercase[row_idx % 26]
            for col_idx, p in enumerate(row):
                if p.x <= px < p.x + p.width and p.y <= py < p.y + p.height:
                    num_case = col_idx + 1
                    self.coord_label.setText(
                        f"Ligne : {letter} | Case : {num_case} | Coordonnées : ({p.x},{p.y})-({p.x+p.width},{p.y+p.height})"
                    )
                    return
        self.coord_label.setText(
            f"Coordonnées : ({px}, {py})"
            + (" | Glisser pour ajouter une case" if self.edit_mode else "")
        )

if __name__ == "__main__":
    app = QApplication(sys.argv)
    # Définir l'icône pour toute l'application
    icon_path = r"C:\Users\miche\OneDrive\Documenten\Projects\BdSplit\Icon.jpg"
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))
    
    app.setStyle("Fusion")
    palette = app.palette()
    palette.setColor(QPalette.ColorRole.Window, QColor(53, 53, 53))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor(53, 53, 53))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.Text, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.Button, QColor(53, 53, 53))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.BrightText, QColor(255, 0, 0))
    palette.setColor(QPalette.ColorRole.Link, QColor(42, 130, 218))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    app.setPalette(palette)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())