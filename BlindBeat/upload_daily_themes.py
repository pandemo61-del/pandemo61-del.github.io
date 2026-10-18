#!/usr/bin/env python3
"""Envoie l'ensemble du calendrier des 365 Journées Mondiales (artists_top500.json) vers Firebase (/Daily_Themes)."""
import json
import logging
import requests
from pathlib import Path

LOG = logging.getLogger("Upload_Daily_Themes")

def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
    json_path = Path("artists_top500.json")

    if not json_path.exists():
        LOG.error("Fichier %s introuvable. Exécutez d'abord python admin/Gen_Events.py", json_path)
        return 1

    with json_path.open("r", encoding="utf-8") as f:
        doc = json.load(f)

    calendar_data = doc.get("calendar", {})
    if not calendar_data:
        LOG.error("Aucune donnée de calendrier trouvée dans %s", json_path)
        return 1

    apiKey = "AIzaSyC6H0bm0KdUO_4K_pgZBv7aaB29JMUNvik"
    auth_url = f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={apiKey}"
    auth_res = requests.post(auth_url, json={"returnSecureToken": True}, timeout=10)
    auth_data = auth_res.json()
    idToken = auth_data.get("idToken")

    if not idToken:
        LOG.error("Échec de l'authentification anonyme Firebase: %s", auth_data)
        return 1

    LOG.info("Authentification Firebase réussie. Envoi des %s jours du calendrier vers /Daily_Themes...", len(calendar_data))

    db_url = f"https://blindbeat-a51d5-default-rtdb.europe-west1.firebasedatabase.app/Daily_Themes.json?auth={idToken}"
    res = requests.put(db_url, json=calendar_data, timeout=30)

    if res.status_code == 200:
        LOG.info("✅ 365 Journées Mondiales synchronisées avec succès sous /Daily_Themes dans Firebase !")
        return 0
    else:
        LOG.error("❌ Erreur d'envoi vers Firebase (%s): %s", res.status_code, res.text)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
