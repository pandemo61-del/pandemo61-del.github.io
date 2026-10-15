#!/usr/bin/env python3
"""
Recherche d'evenements musicaux par jour/mois dans MusicBrainz.

Evenements produits :
- Person + life-span.begin -> birth
- Person + life-span.end -> death
- Group/Orchestra/Choir + life-span.begin -> band_formation
- Group/Orchestra/Choir + life-span.end -> band_dissolution

Exemples :
  python search_musicbrainz_events.py --date 2026-10-15
  python search_musicbrainz_events.py --date 10-15 --pages 3
  python search_musicbrainz_events.py --date 10-15 --types birth death
  python search_musicbrainz_events.py --date 10-15 --no-cache --verbose

Dependance :
  pip install requests
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests

API_URL = "https://musicbrainz.org/ws/2/artist"
DEFAULT_USER_AGENT = "BlindBeat-EventCatalog/0.1 (contact: REPLACE_WITH_YOUR_EMAIL)"
DEFAULT_LIMIT = 100
DEFAULT_PAGES = 2
MIN_REQUEST_INTERVAL_SECONDS = 1.1
DEFAULT_TIMEOUT_SECONDS = 25
DEFAULT_RETRIES = 4
CACHE_TTL_SECONDS = 24 * 60 * 60
RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}
PERSON_TYPES = {"person", "character"}
GROUP_TYPES = {"group", "orchestra", "choir"}
SUPPORTED_EVENT_TYPES = {
    "birth",
    "death",
    "band_formation",
    "band_dissolution",
}


@dataclass(frozen=True)
class Event:
    artist_name: str
    artist_sort_name: str
    artist_type: str
    event_type: str
    event_date: str
    month_day: str
    year: int | None
    musicbrainz_id: str
    country: str | None
    area: str | None
    disambiguation: str | None
    ended: bool | None
    score: int
    source: str = "musicbrainz"

    @property
    def dedupe_key(self) -> str:
        return f"{self.musicbrainz_id}|{self.event_type}|{self.event_date}"


class MusicBrainzClient:
    def __init__(
        self,
        user_agent: str,
        timeout: int = DEFAULT_TIMEOUT_SECONDS,
        retries: int = DEFAULT_RETRIES,
        min_interval: float = MIN_REQUEST_INTERVAL_SECONDS,
        verbose: bool = False,
    ) -> None:
        if "REPLACE_WITH_YOUR_EMAIL" in user_agent:
            logging.warning(
                "Remplacez l'adresse de contact dans DEFAULT_USER_AGENT ou utilisez --contact."
            )

        self.timeout = timeout
        self.retries = retries
        self.min_interval = min_interval
        self.last_request_monotonic = 0.0
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": user_agent,
                "Accept": "application/json",
            }
        )
        logging.getLogger("urllib3").setLevel(
            logging.DEBUG if verbose else logging.WARNING
        )

    def _respect_rate_limit(self) -> None:
        elapsed = time.monotonic() - self.last_request_monotonic
        remaining = self.min_interval - elapsed
        if remaining > 0:
            time.sleep(remaining)

    @staticmethod
    def _retry_delay(response: requests.Response | None, attempt: int) -> float:
        if response is not None:
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    return max(0.0, float(retry_after))
                except ValueError:
                    try:
                        retry_date = datetime.strptime(
                            retry_after, "%a, %d %b %Y %H:%M:%S %Z"
                        ).replace(tzinfo=timezone.utc)
                        return max(
                            0.0,
                            (retry_date - datetime.now(timezone.utc)).total_seconds(),
                        )
                    except ValueError:
                        pass

        return min(30.0, 2**attempt) + random.uniform(0.1, 0.5)

    def get_json(self, params: dict[str, str | int]) -> dict[str, Any]:
        last_error: Exception | None = None

        for attempt in range(self.retries + 1):
            response: requests.Response | None = None
            self._respect_rate_limit()

            try:
                logging.debug("GET %s params=%s", API_URL, params)
                response = self.session.get(
                    API_URL,
                    params=params,
                    timeout=self.timeout,
                )
                self.last_request_monotonic = time.monotonic()

                if response.ok:
                    return response.json()

                if response.status_code not in RETRYABLE_HTTP_STATUS:
                    response.raise_for_status()

                last_error = requests.HTTPError(
                    f"MusicBrainz HTTP {response.status_code}: "
                    f"{response.text[:300]}",
                    response=response,
                )

            except (requests.Timeout, requests.ConnectionError) as exc:
                self.last_request_monotonic = time.monotonic()
                last_error = exc
            except ValueError as exc:
                raise RuntimeError("Reponse JSON MusicBrainz invalide") from exc

            if attempt >= self.retries:
                break

            delay = self._retry_delay(response, attempt)
            logging.warning(
                "Echec MusicBrainz (%s). Nouvel essai %s/%s dans %.1f s.",
                last_error,
                attempt + 1,
                self.retries,
                delay,
            )
            time.sleep(delay)

        raise RuntimeError(
            f"MusicBrainz indisponible apres {self.retries + 1} tentative(s): "
            f"{last_error}"
        )

    def search_artists(
        self,
        query: str,
        pages: int,
        limit: int,
    ) -> Iterable[dict[str, Any]]:
        for page in range(pages):
            offset = page * limit
            payload = self.get_json(
                {
                    "query": query,
                    "fmt": "json",
                    "limit": limit,
                    "offset": offset,
                }
            )

            artists = payload.get("artists", [])
            if not isinstance(artists, list):
                raise RuntimeError("Format MusicBrainz inattendu: 'artists' absent")

            logging.info(
                "Requete %r, page %d: %d artiste(s)",
                query,
                page + 1,
                len(artists),
            )

            yield from artists

            total = int(payload.get("count", 0) or 0)
            if not artists or offset + len(artists) >= total:
                break


def parse_month_day(value: str) -> tuple[int, int, str]:
    patterns = ("%Y-%m-%d", "%m-%d", "%d/%m", "%Y/%m/%d")
    for pattern in patterns:
        try:
            parsed = datetime.strptime(value, pattern)
            return parsed.month, parsed.day, f"{parsed.month:02d}-{parsed.day:02d}"
        except ValueError:
            continue

    raise argparse.ArgumentTypeError(
        "Date invalide. Formats acceptes: YYYY-MM-DD, MM-DD, DD/MM ou YYYY/MM/DD."
    )


def parse_mb_date(value: Any) -> tuple[str, str, int | None] | None:
    if not isinstance(value, str):
        return None

    match = re.fullmatch(r"(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?", value)
    if not match:
        return None

    year = int(match.group(1))
    month = match.group(2)
    day = match.group(3)
    if not month or not day:
        return None

    try:
        date(year, int(month), int(day))
    except ValueError:
        return None

    return value, f"{month}-{day}", year


def classify_event(artist_type: str, field: str) -> str | None:
    normalised = artist_type.strip().lower()
    if normalised in PERSON_TYPES:
        return "birth" if field == "begin" else "death"
    if normalised in GROUP_TYPES:
        return "band_formation" if field == "begin" else "band_dissolution"
    return None


def artist_to_event(
    artist: dict[str, Any],
    field: str,
    expected_month_day: str,
    allowed_types: set[str],
) -> Event | None:
    life_span = artist.get("life-span") or {}
    parsed_date = parse_mb_date(life_span.get(field))
    if parsed_date is None:
        return None

    event_date, month_day, year = parsed_date
    if month_day != expected_month_day:
        return None

    artist_type = str(artist.get("type") or "")
    event_type = classify_event(artist_type, field)
    if event_type is None or event_type not in allowed_types:
        return None

    artist_id = str(artist.get("id") or "").strip()
    artist_name = str(artist.get("name") or "").strip()
    if not artist_id or not artist_name:
        return None

    area_value = artist.get("area") or {}

    return Event(
        artist_name=artist_name,
        artist_sort_name=str(artist.get("sort-name") or artist_name),
        artist_type=artist_type,
        event_type=event_type,
        event_date=event_date,
        month_day=month_day,
        year=year,
        musicbrainz_id=artist_id,
        country=artist.get("country"),
        area=area_value.get("name") if isinstance(area_value, dict) else None,
        disambiguation=artist.get("disambiguation") or None,
        ended=life_span.get("ended"),
        score=int(artist.get("score") or 0),
    )


def build_query(field: str, month: int, day: int) -> str:
    # MusicBrainz indexe begin/end comme des dates textuelles. Le joker permet
    # une recherche par mois/jour, puis le script revalide strictement chaque
    # date retournee avant de produire un evenement.
    return f'{field}:"*-{month:02d}-{day:02d}"'


def cache_path(cache_dir: Path, month_day: str, pages: int) -> Path:
    return cache_dir / f"musicbrainz-events-{month_day}-pages-{pages}.json"


def read_cache(path: Path, ttl_seconds: int) -> list[Event] | None:
    if not path.exists():
        return None

    age = time.time() - path.stat().st_mtime
    if age >= ttl_seconds:
        return None

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        events = payload.get("events", [])
        return [Event(**item) for item in events]
    except (OSError, ValueError, TypeError) as exc:
        logging.warning("Cache ignore (%s): %s", path, exc)
        return None


def write_cache(path: Path, events: list[Event], metadata: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": metadata,
        "events": [asdict(event) for event in events],
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def search_events(
    client: MusicBrainzClient,
    month: int,
    day: int,
    month_day: str,
    allowed_types: set[str],
    pages: int,
    limit: int,
) -> list[Event]:
    results: dict[str, Event] = {}

    fields_needed: list[str] = []
    if allowed_types.intersection({"birth", "band_formation"}):
        fields_needed.append("begin")
    if allowed_types.intersection({"death", "band_dissolution"}):
        fields_needed.append("end")

    for field in fields_needed:
        query = build_query(field, month, day)
        logging.info("Recherche MusicBrainz: %s", query)

        for artist in client.search_artists(query, pages=pages, limit=limit):
            event = artist_to_event(
                artist,
                field=field,
                expected_month_day=month_day,
                allowed_types=allowed_types,
            )
            if event is not None:
                results[event.dedupe_key] = event

    return sorted(
        results.values(),
        key=lambda event: (
            -event.score,
            event.artist_sort_name.casefold(),
            event.event_type,
        ),
    )


def events_by_date(events: list[Event]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        grouped.setdefault(event.month_day, []).append(asdict(event))
    return grouped


def save_outputs(events: list[Event], output_path: Path) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "musicbrainz",
        "event_count": len(events),
        "events": [asdict(event) for event in events],
        "events_by_date": events_by_date(events),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Recherche MusicBrainz des naissances, deces, formations et dissolutions par date."
    )
    parser.add_argument(
        "--date",
        default=datetime.now().strftime("%Y-%m-%d"),
        help="Date: YYYY-MM-DD, MM-DD, DD/MM ou YYYY/MM/DD.",
    )
    parser.add_argument(
        "--types",
        nargs="+",
        choices=sorted(SUPPORTED_EVENT_TYPES),
        default=sorted(SUPPORTED_EVENT_TYPES),
        help="Types d'evenements a conserver.",
    )
    parser.add_argument(
        "--pages",
        type=int,
        default=DEFAULT_PAGES,
        help=f"Pages maximum par requete (defaut: {DEFAULT_PAGES}).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Resultats par page, maximum 100 (defaut: {DEFAULT_LIMIT}).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("musicbrainz_events.json"),
        help="Fichier JSON de sortie.",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(".cache/musicbrainz"),
        help="Dossier de cache.",
    )
    parser.add_argument(
        "--cache-hours",
        type=float,
        default=24.0,
        help="Duree de vie du cache en heures.",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Ignore le cache et force les appels API.",
    )
    parser.add_argument(
        "--contact",
        default="REPLACE_WITH_YOUR_EMAIL",
        help="Adresse ou URL de contact inseree dans User-Agent.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Active les journaux detailles.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        month, day, month_day = parse_month_day(args.date)
    except argparse.ArgumentTypeError as exc:
        logging.error("%s", exc)
        return 2

    if args.pages < 1:
        logging.error("--pages doit etre >= 1")
        return 2
    if not 1 <= args.limit <= 100:
        logging.error("--limit doit etre compris entre 1 et 100")
        return 2
    if args.cache_hours < 0:
        logging.error("--cache-hours doit etre >= 0")
        return 2

    allowed_types = set(args.types)
    cache_file = cache_path(args.cache_dir, month_day, args.pages)
    cache_ttl = int(args.cache_hours * 3600)

    events: list[Event] | None = None
    if not args.no_cache and cache_ttl > 0:
        events = read_cache(cache_file, cache_ttl)
        if events is not None:
            logging.info(
                "Cache utilise: %s (%d evenement(s))",
                cache_file,
                len(events),
            )
            # Le cache peut contenir plus de types qu'actuellement demandes.
            events = [event for event in events if event.event_type in allowed_types]

    if events is None:
        user_agent = (
            f"BlindBeat-EventCatalog/0.1 (contact: {args.contact})"
            if args.contact
            else DEFAULT_USER_AGENT
        )
        client = MusicBrainzClient(
            user_agent=user_agent,
            verbose=args.verbose,
        )

        try:
            events = search_events(
                client=client,
                month=month,
                day=day,
                month_day=month_day,
                allowed_types=allowed_types,
                pages=args.pages,
                limit=args.limit,
            )
        except (RuntimeError, requests.RequestException) as exc:
            logging.error("Recherche echouee: %s", exc)
            return 1

        write_cache(
            cache_file,
            events,
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "month_day": month_day,
                "pages": args.pages,
                "limit": args.limit,
                "types": sorted(allowed_types),
            },
        )

    save_outputs(events, args.output)

    counts: dict[str, int] = {event_type: 0 for event_type in SUPPORTED_EVENT_TYPES}
    for event in events:
        counts[event.event_type] += 1

    logging.info("Sortie: %s", args.output)
    logging.info("Total: %d evenement(s)", len(events))
    for event_type in sorted(counts):
        logging.info("  %-18s %d", event_type, counts[event_type])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
