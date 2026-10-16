#!/usr/bin/env python3
"""Build a ranked BlindBeat catalogue of famous singers and musical groups.

Sources:
- Wikidata Query Service: candidates and structured metadata
- Wikimedia Analytics API: recent French Wikipedia pageviews
- Optional Last.fm API: listeners and playcount

Outputs one JSON file containing the ranking and a month-day calendar index.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

import requests

LOG = logging.getLogger("Build_Top500")
WDQS = "https://query.wikidata.org/sparql"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
PAGEVIEWS_API = (
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
    "fr.wikipedia.org/all-access/user/{article}/daily/{start}/{end}"
)
LASTFM_API = "https://ws.audioscrobbler.com/2.0/"

SUPPORTED_LANGUAGES = ("FR", "EN", "ES", "PT", "NL", "DU")
ALL_LANGUAGES = list(SUPPORTED_LANGUAGES)
COUNTRY_LANGUAGES = {
    "Q30": ALL_LANGUAGES, "Q145": ALL_LANGUAGES,
    "Q142": ["FR"], "Q31": ["FR", "NL"], "Q16": ["FR", "EN"], "Q32": ["FR"],
    "Q55": ["NL"], "Q29999": ["NL"],
    "Q183": ["DU"], "Q40": ["DU"], "Q39": ["DU", "FR"], "Q347": ["DU"],
    "Q45": ["PT"], "Q155": ["PT"], "Q916": ["PT"], "Q1029": ["PT"],
    "Q1007": ["PT"], "Q574": ["PT"], "Q1039": ["PT"], "Q1011": ["PT"],
    "Q29": ["ES"], "Q96": ["ES"], "Q414": ["ES"], "Q739": ["ES"],
    "Q298": ["ES"], "Q419": ["ES"], "Q717": ["ES"], "Q736": ["ES"],
    "Q750": ["ES"], "Q733": ["ES"], "Q77": ["ES"], "Q241": ["ES"],
    "Q786": ["ES"], "Q1183": ["ES"], "Q783": ["ES"], "Q774": ["ES"],
    "Q792": ["ES"], "Q811": ["ES"], "Q800": ["ES"], "Q804": ["ES"],
}

DEFAULT_QUOTAS = {"EN": 180, "FR": 120, "ES": 70, "PT": 40, "DU": 45, "NL": 45}
SINGER_QID = "Q177220"
GROUP_QID = "Q215380"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collecte et classe un Top 500 BlindBeat.")
    parser.add_argument("--output", default="artists_top500.json")
    parser.add_argument("--top", type=int, default=500)
    parser.add_argument("--candidate-limit", type=int, default=1200)
    parser.add_argument("--pageview-days", type=int, default=90)
    parser.add_argument("--lastfm-api-key", default=os.getenv("LASTFM_API_KEY"))
    parser.add_argument("--quotas", default="EN=180,FR=120,ES=70,PT=40,DU=45,NL=45")
    parser.add_argument("--cache-dir", default="admin/.cache/top500")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--contact", default="replace-with-your-email@example.com")
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--request-delay", type=float, default=0.05)
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def parse_quotas(value: str, top: int) -> dict[str, int]:
    quotas: dict[str, int] = {}
    for part in value.split(","):
        key, raw = part.split("=", 1)
        key = key.strip().upper()
        if key not in SUPPORTED_LANGUAGES:
            raise ValueError(f"Langue de quota non supportée: {key}")
        quotas[key] = int(raw)
    if any(number < 0 for number in quotas.values()):
        raise ValueError("Les quotas doivent être positifs")
    if sum(quotas.values()) > top:
        raise ValueError("La somme des quotas ne peut pas dépasser --top")
    return quotas


def chunks(values: list[str], size: int = 50) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield values[index:index + size]


def cache_file(root: Path, namespace: str, key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return root / namespace / f"{digest}.json"


def load_cache(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def save_cache(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
    temporary.replace(path)


def request_json(session, method, url, *, params=None, data=None, timeout=60, retries=4):
    for attempt in range(1, retries + 1):
        try:
            response = session.request(method, url, params=params, data=data, timeout=timeout)
            if response.status_code == 429 and attempt < retries:
                raw = response.headers.get("Retry-After", "10")
                try:
                    delay = max(1, int(raw))
                except ValueError:
                    delay = 10
                time.sleep(delay)
                continue
            if response.status_code in {500, 502, 503, 504} and attempt < retries:
                time.sleep(min(2 ** attempt, 20))
                continue
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError):
            if attempt >= retries:
                raise
            time.sleep(min(2 ** attempt, 20))
    return {}


ARTIST_OCCUPATIONS = ("Q177220", "Q488205", "Q2252262", "Q764144")
GROUP_CLASSES = ("Q215380", "Q5741069", "Q2088357", "Q216337", "Q42998", "Q10648343")


def country_batches() -> list[tuple[str, list[str]]]:
    used: set[str] = set()
    result: list[tuple[str, list[str]]] = []
    for language in SUPPORTED_LANGUAGES:
        countries = [qid for qid, langs in COUNTRY_LANGUAGES.items()
                     if language in langs and qid not in used]
        if countries:
            result.append((language, countries))
            used.update(countries)
    return result


def candidate_query(entity_kind: str, country_ids: list[str], limit: int) -> str:
    countries = " ".join(f"wd:{qid}" for qid in country_ids)
    if entity_kind == "artist":
        occupations = " ".join(f"wd:{qid}" for qid in ARTIST_OCCUPATIONS)
        identity = (
            "?item wdt:P31 wd:Q5 ; wdt:P106 ?occupation ; wdt:P27 ?country . "
            f"VALUES ?occupation {{ {occupations} }}"
        )
    else:
        classes = " ".join(f"wd:{qid}" for qid in GROUP_CLASSES)
        identity = (
            "?item wdt:P31 ?groupClass ; wdt:P495 ?country . "
            f"VALUES ?groupClass {{ {classes} }}"
        )
    return f"""SELECT DISTINCT ?item ?sitelinks ?country WHERE {{
  VALUES ?country {{ {countries} }}
  {identity}
  ?item wikibase:sitelinks ?sitelinks .
}}
ORDER BY DESC(?sitelinks)
LIMIT {limit}"""


def query_country_batch(session, args, cache_root: Path, entity_kind: str,
                        language: str, country_ids: list[str], limit: int):
    query = candidate_query(entity_kind, country_ids, limit)
    path = cache_file(cache_root, "wikidata_queries_v2", query)
    payload = None if args.no_cache else load_cache(path)
    if payload is None:
        LOG.info("Collecte Wikidata: %s/%s (%s pays)",
                 entity_kind, language, len(country_ids))
        try:
            payload = request_json(
                session, "POST", WDQS,
                data={"query": query, "format": "json"},
                timeout=args.timeout, retries=args.retries,
            )
        except requests.RequestException as exc:
            if len(country_ids) == 1:
                LOG.warning("Lot ignoré après échec: %s/%s/%s: %s",
                            entity_kind, language, country_ids[0], exc)
                return []
            middle = len(country_ids) // 2
            LOG.warning("Découpage automatique du lot %s/%s (%s pays)",
                        entity_kind, language, len(country_ids))
            return (
                query_country_batch(session, args, cache_root, entity_kind,
                                    language, country_ids[:middle], limit)
                + query_country_batch(session, args, cache_root, entity_kind,
                                      language, country_ids[middle:], limit)
            )
        if not args.no_cache:
            save_cache(path, payload)
    return payload.get("results", {}).get("bindings", [])


def claim_date(entity: dict[str, Any], property_id: str) -> str | None:
    for claim in entity.get("claims", {}).get(property_id, []):
        value = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(value, dict):
            parsed = iso_date(str(value.get("time") or ""))
            if parsed:
                return parsed
    return None


def enrich_wikidata_metadata(session, qids: list[str], args):
    output = {}
    for batch in chunks(list(dict.fromkeys(qids)), 50):
        payload = request_json(
            session, "GET", WIKIDATA_API,
            params={
                "action": "wbgetentities", "ids": "|".join(batch),
                "props": "labels|claims|sitelinks", "languages": "fr|en",
                "sitefilter": "frwiki", "format": "json",
            },
            timeout=args.timeout, retries=args.retries,
        )
        output.update(payload.get("entities", {}))
    return output


def collect_candidates(session, args, cache_root: Path) -> list[dict[str, Any]]:
    raw = {}
    per_batch_limit = max(100, min(args.candidate_limit, 350))
    for kind in ("artist", "group"):
        for language, countries in country_batches():
            bindings = query_country_batch(
                session, args, cache_root, kind, language,
                countries, per_batch_limit,
            )
            LOG.info("Résultats %s/%s: %s", kind, language, len(bindings))
            for binding in bindings:
                item_url = binding_value(binding, "item")
                qid = qid_from_url(item_url)
                country_id = qid_from_url(binding_value(binding, "country"))
                if not qid or country_id not in COUNTRY_LANGUAGES:
                    continue
                candidate = {
                    "type": kind, "wikidata_id": qid,
                    "wikidata_url": item_url, "country_ID": country_id,
                    "languages": list(COUNTRY_LANGUAGES[country_id]),
                    "sitelinks": int(float(binding_value(binding, "sitelinks") or 0)),
                }
                existing = raw.get(qid)
                if existing is None or candidate["sitelinks"] > existing["sitelinks"]:
                    raw[qid] = candidate

    LOG.info("Identifiants Wikidata à enrichir: %s", len(raw))
    metadata = enrich_wikidata_metadata(session, list(raw), args)
    result = []
    for qid, item in raw.items():
        entity = metadata.get(qid, {})
        labels = entity.get("labels", {})
        name = labels.get("fr", {}).get("value") or labels.get("en", {}).get("value")
        if not name:
            continue
        article_title = entity.get("sitelinks", {}).get("frwiki", {}).get("title")
        item.update({
            "name": name,
            "wikipedia_title": article_title.replace(" ", "_") if article_title else None,
            "wikipedia_url": ("https://fr.wikipedia.org/wiki/" +
                              quote(article_title.replace(" ", "_"))) if article_title else None,
            "birth_date": claim_date(entity, "P569") if item["type"] == "artist" else None,
            "death_date": claim_date(entity, "P570") if item["type"] == "artist" else None,
            "formation_date": claim_date(entity, "P571") if item["type"] == "group" else None,
            "dissolution_date": claim_date(entity, "P576") if item["type"] == "group" else None,
        })
        result.append(item)
    return result


def binding_value(binding: dict[str, Any], key: str) -> str | None:
    value = binding.get(key)
    return str(value.get("value")) if isinstance(value, dict) and value.get("value") is not None else None


def qid_from_url(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"/(Q\d+)$", value)
    return match.group(1) if match else None


def iso_date(value: str | None) -> str | None:
    if not value:
        return None
    match = re.match(r"^[+-]?(\d{4,})-(\d{2})-(\d{2})", value)
    if not match:
        return None
    year, month, day = map(int, match.groups())
    if not (1 <= year <= 9999 and 1 <= month <= 12 and 1 <= day <= 31):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"



def pageviews(session, item, args, cache_root: Path) -> int:
    title = item.get("wikipedia_title")
    if not title:
        return 0
    end_day = datetime.now(timezone.utc).date() - timedelta(days=1)
    start_day = end_day - timedelta(days=args.pageview_days - 1)
    key = f"{title}|{start_day}|{end_day}"
    path = cache_file(cache_root, "pageviews", key)
    payload = None if args.no_cache else load_cache(path)
    if payload is None:
        url = PAGEVIEWS_API.format(
            article=quote(title, safe=""),
            start=start_day.strftime("%Y%m%d") + "00",
            end=end_day.strftime("%Y%m%d") + "00",
        )
        try:
            payload = request_json(session, "GET", url, timeout=args.timeout, retries=args.retries)
        except requests.RequestException:
            return 0
        if not args.no_cache:
            save_cache(path, payload)
        time.sleep(args.request_delay)
    return sum(int(row.get("views", 0)) for row in payload.get("items", []))


def lastfm_stats(session, item, args, cache_root: Path) -> tuple[int, int]:
    if not args.lastfm_api_key:
        return 0, 0
    key = item["wikidata_id"] + "|" + item["name"]
    path = cache_file(cache_root, "lastfm", key)
    payload = None if args.no_cache else load_cache(path)
    if payload is None:
        try:
            payload = request_json(
                session, "GET", LASTFM_API,
                params={
                    "method": "artist.getInfo", "artist": item["name"],
                    "api_key": args.lastfm_api_key, "format": "json", "autocorrect": 1,
                },
                timeout=args.timeout, retries=args.retries,
            )
        except requests.RequestException:
            return 0, 0
        if not args.no_cache:
            save_cache(path, payload)
        time.sleep(args.request_delay)
    stats = payload.get("artist", {}).get("stats", {})
    try:
        return int(stats.get("listeners", 0)), int(stats.get("playcount", 0))
    except (TypeError, ValueError):
        return 0, 0


def relative_log(value: int, maximum: int) -> float:
    return math.log1p(value) / math.log1p(maximum) if value > 0 and maximum > 0 else 0.0


def enrich_and_score(session, candidates, args, cache_root):
    total = len(candidates)
    for index, item in enumerate(candidates, 1):
        item["pageviews"] = pageviews(session, item, args, cache_root)
        listeners, playcount = lastfm_stats(session, item, args, cache_root)
        item["lastfm_listeners"] = listeners
        item["lastfm_playcount"] = playcount
        if index % 50 == 0 or index == total:
            LOG.info("Enrichissement: %s/%s", index, total)

    max_sitelinks = max((x["sitelinks"] for x in candidates), default=0)
    max_views = max((x["pageviews"] for x in candidates), default=0)
    max_listeners = max((x["lastfm_listeners"] for x in candidates), default=0)
    max_playcount = max((x["lastfm_playcount"] for x in candidates), default=0)
    use_lastfm = bool(args.lastfm_api_key and max_listeners)

    for item in candidates:
        sitelinks_score = relative_log(item["sitelinks"], max_sitelinks)
        views_score = relative_log(item["pageviews"], max_views)
        if use_lastfm:
            listener_score = relative_log(item["lastfm_listeners"], max_listeners)
            playcount_score = relative_log(item["lastfm_playcount"], max_playcount)
            stream_score = 0.70 * listener_score + 0.30 * playcount_score
            score = 100 * (0.50 * stream_score + 0.25 * sitelinks_score + 0.25 * views_score)
            method = "lastfm_50_sitelinks_25_pageviews_25"
        else:
            score = 100 * (0.50 * sitelinks_score + 0.50 * views_score)
            method = "sitelinks_50_pageviews_50"
        item["score"] = round(score, 2)
        item["score_method"] = method


def select_with_quotas(candidates, top, quotas):
    ranked = sorted(candidates, key=lambda x: (-x["score"], -x["sitelinks"], x["name"].casefold()))
    selected, used = [], set()
    counts = Counter()
    for language in SUPPORTED_LANGUAGES:
        quota = quotas.get(language, 0)
        for item in ranked:
            if len(selected) >= top or counts[language] >= quota:
                break
            if item["wikidata_id"] in used or language not in item["languages"]:
                continue
            copy = dict(item)
            copy["selected_for_language"] = language
            selected.append(copy)
            used.add(item["wikidata_id"])
            counts[language] += 1
    for item in ranked:
        if len(selected) >= top:
            break
        if item["wikidata_id"] in used:
            continue
        copy = dict(item)
        copy["selected_for_language"] = None
        selected.append(copy)
        used.add(item["wikidata_id"])
    for rank, item in enumerate(selected, 1):
        item["rank"] = rank
    return selected, counts


def calendar_index(selected):
    calendar: dict[str, list[dict[str, Any]]] = defaultdict(list)
    fields = (
        ("birth_date", "birth"), ("death_date", "death"),
        ("formation_date", "band_formation"), ("dissolution_date", "band_dissolution"),
    )
    for item in selected:
        for field, event_type in fields:
            value = item.get(field)
            if not value:
                continue
            month_day = value[5:10]
            calendar[month_day].append({
                "type": event_type, "date": value, "name": item["name"],
                "wikidata_id": item["wikidata_id"], "rank": item["rank"],
                "score": item["score"], "languages": item["languages"],
            })
    for events in calendar.values():
        events.sort(key=lambda x: (x["rank"], x["name"].casefold()))
    return dict(sorted(calendar.items()))


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        if args.top < 1 or args.candidate_limit < args.top or args.pageview_days < 1:
            raise ValueError("--top >= 1, --candidate-limit >= --top et --pageview-days >= 1")
        quotas = parse_quotas(args.quotas, args.top)
    except ValueError as exc:
        LOG.error("%s", exc)
        return 2

    cache_root = Path(args.cache_dir)
    session = requests.Session()
    session.headers.update({
        "User-Agent": f"BlindBeat-Top500/2.0 (contact: {args.contact})",
        "Accept": "application/json",
    })
    try:
        candidates = collect_candidates(session, args, cache_root)
        LOG.info("Candidats uniques admissibles: %s", len(candidates))
        enrich_and_score(session, candidates, args, cache_root)
        selected, quota_counts = select_with_quotas(candidates, args.top, quotas)
    except requests.RequestException as exc:
        LOG.error("Erreur réseau: %s", exc)
        return 1
    finally:
        session.close()

    calendar = calendar_index(selected)
    document = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "requested_top": args.top,
        "candidate_count": len(candidates),
        "selected_count": len(selected),
        "pageview_days": args.pageview_days,
        "lastfm_enabled": bool(args.lastfm_api_key),
        "requested_quotas": quotas,
        "fulfilled_quota_slots": dict(quota_counts),
        "covered_calendar_days": len(calendar),
        "ranking": selected,
        "calendar": calendar,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temporary.replace(output)
    LOG.info("Top sélectionné: %s", len(selected))
    LOG.info("Jours du calendrier couverts: %s", len(calendar))
    LOG.info("Sortie: %s", output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
