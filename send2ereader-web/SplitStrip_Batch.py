#!/usr/bin/env python3
"""Traitement batch pour Comic Panel Extractor.

Ce fichier s'utilise avec le programme original sauvegarde sous le nom
``Main.py`` dans le meme dossier. Il reutilise FileHandler, PanelDetector,
PanelLearningModel, Panel et E_READERS sans lancer l'interface PyQt.
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import List

import cv2
import numpy as np

try:
    from Main import (
        E_READERS,
        FileHandler,
        Panel,
        PanelDetector,
        PanelLearningModel,
    )
except ImportError as error:
    print(
        "Erreur : placez ce fichier dans le meme dossier que Main.py.\n"
        f"Detail : {error}",
        file=sys.stderr,
    )
    raise SystemExit(2)


SUPPORTED_EXTENSIONS = {".pdf", ".cbz", ".cbr", ".zip", ".rar"}
TRAINING_PATH = Path.home() / ".bdsplit_panel_training.json"


def natural_sort_key(path: Path):
    return FileHandler._natural_sort_key(str(path))


def load_training_examples():
    if not TRAINING_PATH.is_file():
        return {}

    try:
        with TRAINING_PATH.open("r", encoding="utf-8") as stream:
            payload = json.load(stream)
    except (OSError, json.JSONDecodeError) as error:
        print(
            f"Attention : apprentissage ignore, lecture impossible : {error}",
            file=sys.stderr,
        )
        return {}

    raw_pages = payload.get("pages", {})
    if not isinstance(raw_pages, dict):
        print(
            "Attention : apprentissage ignore, structure invalide.",
            file=sys.stderr,
        )
        return {}

    pages = {}
    for page_id, raw_entry in raw_pages.items():
        if isinstance(raw_entry, list):
            pages[page_id] = {
                "boxes": raw_entry,
                "samples": [],
                "group": page_id,
            }
        elif isinstance(raw_entry, dict):
            pages[page_id] = {
                "boxes": raw_entry.get("boxes", []),
                "samples": raw_entry.get("samples", []),
                "group": raw_entry.get("group", page_id),
                "detected_boxes": raw_entry.get("detected_boxes"),
            }
    return pages


def page_signature(image: np.ndarray) -> str:
    digest = hashlib.sha256()
    digest.update(str(image.shape).encode("ascii"))
    digest.update(image.tobytes())
    return digest.hexdigest()


def panels_from_annotations(image: np.ndarray, annotations) -> List[Panel]:
    page_height, page_width = image.shape[:2]
    panels = []

    for box in annotations or []:
        if not isinstance(box, list) or len(box) != 4:
            continue

        x, y, width, height = (int(value) for value in box)
        if (
            x < 0
            or y < 0
            or width <= 0
            or height <= 0
            or x + width > page_width
            or y + height > page_height
        ):
            continue

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


def find_input_files(input_dir: Path, recursive: bool):
    candidates = input_dir.rglob("*") if recursive else input_dir.iterdir()
    return sorted(
        (
            path
            for path in candidates
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        ),
        key=natural_sort_key,
    )


def build_jobs(input_dir: Path, output_dir: Path, recursive: bool):
    jobs = []

    for input_path in find_input_files(input_dir, recursive):
        relative_parent = (
            input_path.parent.relative_to(input_dir) if recursive else Path()
        )
        target_dir = output_dir / relative_parent
        output_path = target_dir / f"{input_path.stem}.cbz"

        # Si input et output sont identiques, ne jamais remplacer la source CBZ.
        if input_path.resolve() == output_path.resolve():
            output_path = target_dir / f"{input_path.stem}_panels.cbz"

        jobs.append((input_path, output_path))

    return jobs


def confirm_once(jobs, overwrite: bool):
    existing = [output for _, output in jobs if output.exists()]

    print(f"{len(jobs)} fichier(s) a traiter.")
    if existing and overwrite:
        print(f"{len(existing)} fichier(s) existant(s) seront ecrase(s).")
    elif existing:
        print(f"{len(existing)} fichier(s) existant(s) seront ignores.")
    else:
        print("Aucun fichier de sortie existant ne sera ecrase.")

    try:
        answer = input("Continuer ? [o/N] ").strip().casefold()
    except EOFError:
        return False

    return answer in {"o", "oui", "y", "yes"}


class BatchProcessor:
    def __init__(self, resolution=None):
        self.resolution = resolution
        self.file_handler = FileHandler()
        self.detector = PanelDetector()
        self.examples = load_training_examples()
        self.learning_model = PanelLearningModel()

        try:
            self.learning_model.fit(self.examples)
        except (ValueError, TypeError, FloatingPointError) as error:
            print(
                f"Attention : modele appris ignore : {error}",
                file=sys.stderr,
            )
            self.learning_model = PanelLearningModel()

    def process(self, input_path: Path, output_path: Path):
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            total_pages = self.file_handler.open_file(str(input_path))
            panels_by_page = []

            for page_index in range(total_pages):
                print(
                    f"\r  Page {page_index + 1}/{total_pages}",
                    end="",
                    flush=True,
                )

                image = self.file_handler.get_page(page_index)
                if image is None:
                    raise ValueError(
                        f"Impossible de lire la page {page_index + 1}."
                    )

                saved = self.examples.get(page_signature(image))
                if saved is not None:
                    panels = panels_from_annotations(
                        image,
                        saved.get("boxes", []),
                    )
                elif page_index < 2:
                    panels = []
                else:
                    panels = self.detector.detect_panels(image)
                    panels = self.learning_model.filter_panels(image, panels)

                panels_by_page.append(
                    self.detector._group_panels_into_rows(panels)
                )

            print()
            self.file_handler.save_cbz(
                str(output_path),
                panels_by_page,
                self.resolution,
            )
            return total_pages
        finally:
            self.file_handler.cleanup()


def build_parser():
    parser = argparse.ArgumentParser(
        description="Traite un dossier de BD sans interface graphique."
    )
    parser.add_argument(
        "--input",
        "-i",
        type=Path,
        required=True,
        help="Dossier source contenant PDF, CBZ, CBR, ZIP ou RAR.",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        required=True,
        help="Dossier de destination des fichiers CBZ.",
    )
    parser.add_argument(
        "--recursive",
        "-r",
        action="store_true",
        help="Inclure les sous-dossiers et conserver leur structure.",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Ne pas demander de confirmation.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Ecraser les fichiers de sortie existants.",
    )
    parser.add_argument(
        "--ereader",
        choices=sorted(E_READERS),
        help="Modele d'e-reader cible.",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    input_dir = args.input.expanduser().resolve()
    output_dir = args.output.expanduser().resolve()

    if not input_dir.is_dir():
        print(
            f"Erreur : dossier input absent ou invalide : {input_dir}",
            file=sys.stderr,
        )
        return 2

    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(
            f"Erreur : creation du dossier output impossible : {error}",
            file=sys.stderr,
        )
        return 2

    jobs = build_jobs(input_dir, output_dir, args.recursive)
    if not jobs:
        print("Aucun fichier compatible trouve.")
        return 0

    if not args.yes and not confirm_once(jobs, args.overwrite):
        print("Traitement annule.")
        return 0

    if not args.overwrite:
        skipped = sum(output.exists() for _, output in jobs)
        jobs = [(source, output) for source, output in jobs if not output.exists()]
        if skipped:
            print(f"{skipped} fichier(s) existant(s) ignore(s).")

    if not jobs:
        print("Aucun fichier a traiter.")
        return 0

    resolution = E_READERS.get(args.ereader) if args.ereader else None
    processor = BatchProcessor(resolution)
    successful = 0
    failed = 0

    for index, (source, destination) in enumerate(jobs, start=1):
        print(f"[{index}/{len(jobs)}] {source} -> {destination}")
        try:
            page_count = processor.process(source, destination)
            successful += 1
            print(f"  OK : {page_count} page(s).")
        except Exception as error:
            failed += 1
            print(f"  ERREUR : {error}", file=sys.stderr)

    print(
        f"Termine : {successful} reussi(s), {failed} erreur(s), "
        f"{len(jobs)} traite(s)."
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
