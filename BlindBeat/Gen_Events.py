#!/usr/bin/env python3
"""Generate music-related historical events from Wikidata.

Examples:
    python admin/Gen_Events.py --date 2026-10-15
    python admin/Gen_Events.py --date 10-15
    python admin/Gen_Events.py --date 2026-10-15 --no-cache --verbose
    python admin/Gen_Events.py --date 10-15 --min-year 1900 --max-year 2026

Only singers are retained for birth/death events. Popularity is the number
of Wikimedia sitelinks reported by Wikidata. Country of citizenship (people)
or country of origin (groups) is used to assign app language codes. English
or US/UK content is available to all supported languages.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import requests

WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
DEFAULT_OUTPUT = "wikidata_events.json"
DEFAULT_CACHE_DIR = Path(__file__).resolve().parent / ".cache" / "wikidata"
DEFAULT_TIMEOUT = 90
DEFAULT_RETRIES = 4
DEFAULT_LANGUAGE = "fr"
DEFAULT_MIN_YEAR = 1950
DEFAULT_MAX_YEAR = date.today().year
DEFAULT_YEAR_CHUNK = 25
DEFAULT_USER_AGENT = (
    "BlindBeat-EventGenerator/3.5 "
    "(contact: replace-with-your-email@example.com)"
)

LOGGER = logging.getLogger("Gen_Events")

SUPPORTED_LANGUAGES = ("FR", "EN", "ES", "PT", "NL", "DU")
ALL_LANGUAGES = list(SUPPORTED_LANGUAGES)

# Application language routing based on Wikidata country identifiers.
# "DU" is kept because it is the language code used by the application.
COUNTRY_LANGUAGE_MAP = {
    # English-speaking / US content is available to every supported language.
    "Q30": ALL_LANGUAGES,   # United States
    "Q145": ALL_LANGUAGES,  # United Kingdom

    # French
    "Q142": ["FR"],        # France
    "Q31": ["FR", "NL"], # Belgium
    "Q16": ["FR", "EN"], # Canada
    "Q32": ["FR"],        # Luxembourg
    "Q1008": ["FR"],      # Ivory Coast
    "Q1041": ["FR"],      # Senegal

    # Dutch
    "Q55": ["NL"],        # Netherlands
    "Q29999": ["NL"],     # Kingdom of the Netherlands

    # German, application code DU
    "Q183": ["DU"],       # Germany
    "Q40": ["DU"],        # Austria
    "Q39": ["DU", "FR"], # Switzerland
    "Q347": ["DU"],       # Liechtenstein

    # Portuguese
    "Q45": ["PT"],        # Portugal
    "Q155": ["PT"],       # Brazil
    "Q1029": ["PT"],      # Mozambique
    "Q1007": ["PT"],      # Guinea-Bissau
    "Q916": ["PT"],       # Angola
    "Q574": ["PT"],       # East Timor
    "Q1039": ["PT"],      # São Tomé and Príncipe
    "Q1011": ["PT"],      # Cape Verde

    # Spanish
    "Q29": ["ES"],        # Spain
    "Q96": ["ES"],        # Mexico
    "Q414": ["ES"],       # Argentina
    "Q739": ["ES"],       # Colombia
    "Q298": ["ES"],       # Chile
    "Q419": ["ES"],       # Peru
    "Q717": ["ES"],       # Venezuela
    "Q736": ["ES"],       # Ecuador
    "Q750": ["ES"],       # Bolivia
    "Q733": ["ES"],       # Paraguay
    "Q77": ["ES"],        # Uruguay
    "Q241": ["ES"],       # Cuba
    "Q786": ["ES"],       # Dominican Republic
    "Q1183": ["ES"],      # Puerto Rico
    "Q783": ["ES"],       # Honduras
    "Q774": ["ES"],       # Guatemala
    "Q792": ["ES"],       # El Salvador
    "Q811": ["ES"],       # Nicaragua
    "Q800": ["ES"],       # Costa Rica
    "Q804": ["ES"],       # Panama
}
EVENT_TYPES = ("band_dissolution", "band_formation", "birth", "death")

EVENT_LABELS = {
    "fr": {
        "birth": "Naissance",
        "death": "Décès",
        "band_formation": "Formation du groupe",
        "band_dissolution": "Dissolution du groupe",
    },
    "en": {
        "birth": "Birth",
        "death": "Death",
        "band_formation": "Band formation",
        "band_dissolution": "Band dissolution",
    },
}

# Direct occupations/classes are used deliberately. Recursive P279* paths made
# the public Wikidata Query Service time out for this workload.
SINGER_OCCUPATION = "Q177220"  # singer / chanteur


MUSIC_GROUP_CLASSES = (
    "Q215380",    # musical group
    "Q5741069",   # rock band
    "Q2088357",   # musical ensemble
    "Q216337",    # boy band
    "Q42998",     # orchestra
    "Q10648343",  # duo
)


@dataclass(frozen=True)
class EventDefinition:
    event_type: str
    property_id: str
    entity_kind: str


EVENT_DEFINITIONS = (
    EventDefinition("birth", "P569", "person"),
    EventDefinition("death", "P570", "person"),
    EventDefinition("band_formation", "P571", "group"),
    EventDefinition("band_dissolution", "P576", "group"),
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Génère des événements musicaux historiques depuis Wikidata."
    )
    parser.add_argument("--date", required=True, help="Date YYYY-MM-DD ou MM-DD.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Fichier JSON de sortie.")
    parser.add_argument("--language", default=DEFAULT_LANGUAGE, help="Langue des libellés.")
    parser.add_argument("--contact", help="Adresse de contact pour le User-Agent Wikidata.")
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE_DIR))
    parser.add_argument("--no-cache", action="store_true", help="Ignore le cache local.")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument("--min-year", type=int, default=DEFAULT_MIN_YEAR)
    parser.add_argument("--max-year", type=int, default=DEFAULT_MAX_YEAR)
    parser.add_argument(
        "--year-chunk",
        type=int,
        default=DEFAULT_YEAR_CHUNK,
        help="Nombre de dates historiques regroupées par requête Wikidata.",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=1,
        help=(
            "Nombre de jours calendaires à traiter à partir de --date, "
            "date de départ incluse. Défaut : 1."
        ),
    )
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )


def parse_target_date(value: str) -> tuple[Optional[int], int, int]:
    value = value.strip()
    full = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value)
    if full:
        year, month, day = map(int, full.groups())
        date(year, month, day)
        return year, month, day

    partial = re.fullmatch(r"(\d{2})-(\d{2})", value)
    if partial:
        month, day = map(int, partial.groups())
        date(2000, month, day)
        return None, month, day

    raise ValueError("Format invalide. Utilisez YYYY-MM-DD ou MM-DD.")


def valid_years_for_day(min_year: int, max_year: int, month: int, day: int) -> list[int]:
    years: list[int] = []
    for year in range(min_year, max_year + 1):
        try:
            date(year, month, day)
            years.append(year)
        except ValueError:
            continue
    return years


def chunks(values: list[int], size: int):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def build_entity_filter(definition: EventDefinition) -> str:
    if definition.entity_kind == "person":
        # Keep only people whose occupation is singer or a subclass of singer.
        # The exact-date VALUES clause narrows the candidates before this path.
        return f"""
    ?item wdt:P31 wd:Q5 ;
          wdt:P106/wdt:P279* wd:{SINGER_OCCUPATION} .

    # Exclude people also classified as actors or actress subclasses.
    FILTER NOT EXISTS {{
        ?item wdt:P106/wdt:P279* wd:Q33999 .
    }}

    OPTIONAL {{ ?item wdt:P27 ?country . }}
""".rstrip()

    classes = " ".join(f"wd:{qid}" for qid in MUSIC_GROUP_CLASSES)
    return f"""
    ?item wdt:P31 ?groupType .
    VALUES ?groupType {{ {classes} }}
    OPTIONAL {{ ?item wdt:P495 ?country . }}
""".rstrip()


def build_sparql_query(
    definition: EventDefinition,
    years: list[int],
    month: int,
    day: int,
    language: str,
) -> str:
    # Exact date values are indexed and avoid global MONTH()/DAY() scans.
    date_values = "\n        ".join(
        f'"{year:04d}-{month:02d}-{day:02d}T00:00:00Z"^^xsd:dateTime'
        for year in years
    )
    entity_filter = build_entity_filter(definition)

    return f"""
SELECT DISTINCT ?item ?itemLabel ?itemDescription ?eventDate ?article
                ?popularity ?country ?countryLabel
WHERE {{
    VALUES ?eventDate {{
        {date_values}
    }}

    ?item wdt:{definition.property_id} ?eventDate ;
          wikibase:sitelinks ?popularity .
{entity_filter}

    OPTIONAL {{
        ?article schema:about ?item ;
                 schema:isPartOf <https://{language}.wikipedia.org/> .
    }}

    SERVICE wikibase:label {{
        bd:serviceParam wikibase:language "{language},en" .
    }}
}}
ORDER BY ?eventDate ?itemLabel
""".strip()


def cache_file_for_query(cache_dir: Path, query: str) -> Path:
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()
    return cache_dir / f"{digest}.json"


def load_cache(path: Path) -> Optional[dict[str, Any]]:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        LOGGER.warning("Cache invalide %s: %s", path, exc)
        return None


def save_cache(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    temporary.replace(path)


def build_user_agent(contact: Optional[str]) -> str:
    if contact:
        return f"BlindBeat-EventGenerator/3.5 (contact: {contact})"
    LOGGER.warning(
        "Remplacez l'adresse de contact dans DEFAULT_USER_AGENT ou utilisez --contact."
    )
    return DEFAULT_USER_AGENT


def request_wikidata(
    session: requests.Session,
    query: str,
    event_type: str,
    timeout: int,
    retries: int,
) -> dict[str, Any]:
    for attempt in range(1, retries + 1):
        try:
            LOGGER.debug(
                "POST %s event_type=%s tentative=%s/%s",
                WIKIDATA_SPARQL_URL,
                event_type,
                attempt,
                retries,
            )
            response = session.post(
                WIKIDATA_SPARQL_URL,
                data={"query": query, "format": "json"},
                timeout=timeout,
            )

            if response.status_code == 429:
                raw_delay = response.headers.get("Retry-After", "10")
                try:
                    delay = max(1, int(raw_delay))
                except ValueError:
                    delay = 10
                LOGGER.warning("Limite Wikidata 429. Nouvelle tentative dans %ss.", delay)
                if attempt < retries:
                    time.sleep(delay)
                    continue

            if response.status_code in {500, 502, 503, 504}:
                delay = min(2 ** attempt, 20)
                LOGGER.warning(
                    "Erreur Wikidata HTTP %s. Nouvelle tentative dans %ss.",
                    response.status_code,
                    delay,
                )
                if attempt < retries:
                    time.sleep(delay)
                    continue

            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload.get("results", {}).get("bindings"), list):
                raise RuntimeError("Réponse Wikidata invalide: results.bindings absent.")
            return payload

        except (requests.RequestException, ValueError) as exc:
            if attempt >= retries:
                raise RuntimeError(
                    f"Échec Wikidata pour {event_type} après {retries} tentative(s): {exc}"
                ) from exc
            delay = min(2 ** attempt, 20)
            LOGGER.warning("Erreur réseau/JSON: %s. Nouvelle tentative dans %ss.", exc, delay)
            time.sleep(delay)

    raise RuntimeError(f"Impossible d'interroger Wikidata pour {event_type}.")


def execute_query(
    session: requests.Session,
    definition: EventDefinition,
    years: list[int],
    month: int,
    day: int,
    language: str,
    cache_dir: Path,
    use_cache: bool,
    timeout: int,
    retries: int,
) -> dict[str, Any]:
    query = build_sparql_query(definition, years, month, day, language)
    cache_file = cache_file_for_query(cache_dir, query)

    if use_cache:
        cached = load_cache(cache_file)
        if cached is not None:
            LOGGER.debug(
                "Cache Wikidata: %s, années %s-%s",
                definition.event_type,
                years[0],
                years[-1],
            )
            return cached

    LOGGER.debug(
        "Recherche Wikidata: %s, %02d-%02d, années %s-%s",
        definition.event_type,
        month,
        day,
        years[0],
        years[-1],
    )
    LOGGER.debug("SPARQL:\n%s", query)
    payload = request_wikidata(session, query, definition.event_type, timeout, retries)
    if use_cache:
        save_cache(cache_file, payload)
    return payload


def binding_value(binding: dict[str, Any], key: str) -> Optional[str]:
    value = binding.get(key)
    if not isinstance(value, dict):
        return None
    raw = value.get("value")
    return str(raw) if raw is not None else None


def extract_qid(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    candidate = urlparse(value).path.rstrip("/").split("/")[-1]
    return candidate if re.fullmatch(r"Q\d+", candidate) else None


def application_languages(country_qid: Optional[str]) -> Optional[list[str]]:
    """Return app language codes inferred from the origin country.

    Missing or unmapped countries are ignored. US and UK are routed to every
    supported language.
    """
    if not country_qid:
        return None
    mapped = COUNTRY_LANGUAGE_MAP.get(country_qid)
    return list(mapped) if mapped else None


def parse_wikidata_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalise_binding(
    binding: dict[str, Any],
    definition: EventDefinition,
    language: str,
) -> Optional[dict[str, Any]]:
    item_url = binding_value(binding, "item")
    qid = extract_qid(item_url)
    name = binding_value(binding, "itemLabel")
    event_datetime = parse_wikidata_datetime(binding_value(binding, "eventDate"))
    if not qid or not name or event_datetime is None:
        return None

    popularity_raw = binding_value(binding, "popularity")
    try:
        popularity = int(float(popularity_raw or "0"))
    except ValueError:
        popularity = 0

    # Remove little-known entries. Popularity is the Wikidata sitelink count.
    if popularity < 15:
        LOGGER.debug(
            "Résultat ignoré: popularité insuffisante pour %s (%s < 15)",
            name,
            popularity,
        )
        return None

    country_url = binding_value(binding, "country")
    country_qid = extract_qid(country_url)
    country_name = binding_value(binding, "countryLabel")
    languages = application_languages(country_qid)
    if languages is None:
        LOGGER.debug(
            "Résultat ignoré: country_ID absent ou non reconnu pour %s (%s)",
            name,
            country_qid,
        )
        return None

    source_description = binding_value(binding, "itemDescription")
    description = source_description
    if country_name:
        description = f"{source_description} · Origine : {country_name}" if source_description else f"Origine : {country_name}"

    labels = EVENT_LABELS.get(language, EVENT_LABELS["en"])
    return {
        "id": f"wikidata-{definition.event_type}-{qid}",
        "type": definition.event_type,
        "type_label": labels.get(definition.event_type, definition.event_type),
        "date": event_datetime.date().isoformat(),
        "year": event_datetime.year,
        "month": event_datetime.month,
        "day": event_datetime.day,
        "name": name,
        "description": description,
        "country": country_name,
        "country_ID": country_qid,
        "languages": languages,
        "wikidata_id": qid,
        "wikidata_url": item_url,
        "wikipedia_url": binding_value(binding, "article"),
        "image_url": None,
        "date_precision": 11,
        "popularity": popularity,
        "popularity_metric": "wikidata_sitelinks",
        "source": "Wikidata",
    }


def convert_results(
    payload: dict[str, Any],
    definition: EventDefinition,
    language: str,
    month: int,
    day: int,
) -> list[dict[str, Any]]:
    bindings = payload.get("results", {}).get("bindings", [])
    events: list[dict[str, Any]] = []
    for binding in bindings:
        event = normalise_binding(binding, definition, language)
        if event and event["month"] == month and event["day"] == day:
            events.append(event)
    LOGGER.debug(
        "Wikidata '%s': %s résultat(s), %s événement(s) retenu(s)",
        definition.event_type,
        len(bindings),
        len(events),
    )
    return events


def deduplicate_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[str, str, str], dict[str, Any]] = {}
    for event in events:
        key = (event["type"], event["wikidata_id"], event["date"])
        existing = unique.get(key)
        if existing is None:
            unique[key] = event
        elif not existing.get("wikipedia_url") and event.get("wikipedia_url"):
            existing["wikipedia_url"] = event["wikipedia_url"]
    return sorted(
        unique.values(),
        key=lambda event: (-event["popularity"], event["year"], event["type"], event["name"].casefold()),
    )


def top_fr_artists(events: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    """Prioritise French and Belgian singers, then complete from FR content.

    Tier 1: country_ID Q142 (France) or Q31 (Belgium), ordered by popularity.
    Tier 2: other singers whose languages include FR, ordered by popularity.
    Artists remain unique across both tiers.
    """
    artists: dict[str, dict[str, Any]] = {}

    for event in events:
        if event.get("type") not in {"birth", "death"}:
            continue
        if "FR" not in event.get("languages", []):
            continue

        artist_id = str(event.get("wikidata_id") or "")
        country_id = event.get("country_ID")
        if not artist_id or not country_id:
            continue

        candidate = {
            "name": event.get("name"),
            "popularity": event.get("popularity", 0),
            "country": event.get("country"),
            "country_ID": country_id,
            "wikidata_id": artist_id,
            "wikidata_url": event.get("wikidata_url"),
            "selection_tier": (
                "FR_BE_origin" if country_id in {"Q142", "Q31"}
                else "FR_available_fallback"
            ),
        }

        existing = artists.get(artist_id)
        if existing is None or candidate["popularity"] > existing["popularity"]:
            artists[artist_id] = candidate

    primary = sorted(
        (
            artist for artist in artists.values()
            if artist["country_ID"] in {"Q142", "Q31"}
        ),
        key=lambda artist: (-artist["popularity"], str(artist["name"]).casefold()),
    )

    fallback = sorted(
        (
            artist for artist in artists.values()
            if artist["country_ID"] not in {"Q142", "Q31"}
        ),
        key=lambda artist: (-artist["popularity"], str(artist["name"]).casefold()),
    )

    return (primary + fallback)[:limit]


def write_output(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temporary.replace(path)


def main() -> int:
    args = parse_arguments()
    configure_logging(args.verbose)

    try:
        requested_year, requested_month, requested_day = parse_target_date(args.date)
        if args.days < 1:
            raise ValueError("--days doit être au moins égal à 1.")
        if args.days > 1 and requested_year is None:
            raise ValueError(
                "--date doit être au format YYYY-MM-DD lorsque --days est supérieur à 1."
            )
        if args.min_year > args.max_year:
            raise ValueError("--min-year ne peut pas dépasser --max-year.")
        if args.year_chunk < 1:
            raise ValueError("--year-chunk doit être au moins égal à 1.")

        if requested_year is not None:
            start_date = date(requested_year, requested_month, requested_day)
        else:
            # For one day, MM-DD remains accepted. The year only identifies the run date.
            start_date = date(date.today().year, requested_month, requested_day)

        target_dates = [start_date + timedelta(days=offset) for offset in range(args.days)]
    except ValueError as exc:
        LOGGER.error("%s", exc)
        return 2

    session = requests.Session()
    session.headers.update({
        "User-Agent": build_user_agent(args.contact),
        "Accept": "application/sparql-results+json, application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    })

    all_events: list[dict[str, Any]] = []
    date_results: list[dict[str, Any]] = []

    try:
        for target_date in target_dates:
            month = target_date.month
            day = target_date.day
            years = valid_years_for_day(args.min_year, args.max_year, month, day)
            if not years:
                LOGGER.warning("Aucune année historique valide pour %02d-%02d.", month, day)
                continue

            day_events: list[dict[str, Any]] = []
            LOGGER.info("Traitement du %s", target_date.isoformat())

            for definition in EVENT_DEFINITIONS:
                for year_group in chunks(years, args.year_chunk):
                    payload = execute_query(
                        session=session,
                        definition=definition,
                        years=year_group,
                        month=month,
                        day=day,
                        language=args.language,
                        cache_dir=Path(args.cache_dir),
                        use_cache=not args.no_cache,
                        timeout=args.timeout,
                        retries=args.retries,
                    )
                    converted = convert_results(
                        payload, definition, args.language, month, day
                    )
                    for event in converted:
                        event["requested_date"] = target_date.isoformat()
                    day_events.extend(converted)
                    time.sleep(0.5)

            day_events = deduplicate_events(day_events)
            day_counts = Counter(event["type"] for event in day_events)
            day_top_fr = top_fr_artists(day_events, limit=3)
            all_events.extend(day_events)
            date_results.append({
                "requested_date": target_date.isoformat(),
                "month": month,
                "day": day,
                "total": len(day_events),
                "counts": {
                    event_type: day_counts.get(event_type, 0)
                    for event_type in EVENT_TYPES
                },
                "top_3_fr_artists_by_popularity": day_top_fr,
            })
            LOGGER.info(
                "Top 3 FR pour le %s",
                target_date.isoformat(),
            )

            for position, artist in enumerate(day_top_fr, start=1):
                LOGGER.info(
                    "  %s. %s | popularité=%s | country_ID=%s",
                    position,
                    artist["name"],
                    artist["popularity"],
                    artist["country_ID"],
                )
            LOGGER.info(
                "%s événement(s) trouvés pour le %s",
                len(day_events),
                target_date.isoformat(),
            )

    except (RuntimeError, OSError) as exc:
        LOGGER.error("%s", exc)
        return 1
    finally:
        session.close()

    events = deduplicate_events(all_events)
    counts = Counter(event["type"] for event in events)
    fr_top_3 = top_fr_artists(events, limit=3)
    end_date = target_dates[-1]

    document = {
        "source": "Wikidata",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "requested_start_date": start_date.isoformat(),
        "requested_end_date": end_date.isoformat(),
        "requested_days": args.days,
        "searched_min_year": args.min_year,
        "searched_max_year": args.max_year,
        "filters": {
            "people_must_be_singers": True,
            "exclude_actor_occupation": True,
            "minimum_popularity": 15,
            "minimum_year": args.min_year,
            "ignore_missing_or_unknown_country_ID": True,
        },
        "language": args.language,
        "total": len(events),
        "counts": {event_type: counts.get(event_type, 0) for event_type in EVENT_TYPES},
        "summary": {
            "top_3_fr_artists_by_popularity": fr_top_3,
            "popularity_metric": "wikidata_sitelinks",
            "dates": date_results,
        },
        "events": events,
    }

    output_path = Path(args.output)
    try:
        write_output(output_path, document)
    except OSError as exc:
        LOGGER.error("Impossible d'écrire %s: %s", output_path, exc)
        return 1

    LOGGER.info("Sortie: %s", output_path)
    LOGGER.info(
        "Période traitée: %s au %s (%s jour(s))",
        start_date.isoformat(),
        end_date.isoformat(),
        args.days,
    )
    LOGGER.info("Total: %s evenement(s)", len(events))
    for event_type in EVENT_TYPES:
        LOGGER.info("  %-18s %s", event_type, counts.get(event_type, 0))
    LOGGER.info("Top 3 artistes FR par popularité sur la période:")
    for position, artist in enumerate(fr_top_3, start=1):
        LOGGER.info(
            "  %s. %s | popularité=%s | country_ID=%s",
            position,
            artist["name"],
            artist["popularity"],
            artist["country_ID"],
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
