#!/usr/bin/env python3
"""Générateur de calendrier BlindBeat basé sur les Journées Mondiales et Internationales.

Pour chaque jour de l'année (365 jours), associe la version officielle d'une "Journée mondiale",
un thème musical dédié, et une sélection de 20 chansons emblématiques.

Sortie: artists_top500.json (ou chemin personnalisé via --output)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

LOG = logging.getLogger("Gen_Events_WorldDays")

DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
MONTH_NAMES_FR = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre"
]

# Banque de thèmes musicaux et leurs 20 chansons associées
THEME_PLAYLISTS: dict[str, list[dict[str, Any]]] = {
    "PAIX_HARMONIE": [
        {"title": "Imagine", "artist": "John Lennon", "year": 1971, "language": "EN"},
        {"title": "Heal the World", "artist": "Michael Jackson", "year": 1991, "language": "EN"},
        {"title": "Give Peace a Chance", "artist": "The Plastic Ono Band", "year": 1969, "language": "EN"},
        {"title": "Blowin' in the Wind", "artist": "Bob Dylan", "year": 1963, "language": "EN"},
        {"title": "What a Wonderful World", "artist": "Louis Armstrong", "year": 1967, "language": "EN"},
        {"title": "One", "artist": "U2", "year": 1991, "language": "EN"},
        {"title": "Zombie", "artist": "The Cranberries", "year": 1994, "language": "EN"},
        {"title": "Man in the Mirror", "artist": "Michael Jackson", "year": 1987, "language": "EN"},
        {"title": "Un autre monde", "artist": "Téléphone", "year": 1984, "language": "FR"},
        {"title": "Chanter", "artist": "Florent Pagny", "year": 1997, "language": "FR"},
        {"title": "We Are the World", "artist": "USA for Africa", "year": 1985, "language": "EN"},
        {"title": "Where Is the Love?", "artist": "The Black Eyed Peas", "year": 2003, "language": "EN"},
        {"title": "Peace Train", "artist": "Cat Stevens", "year": 1971, "language": "EN"},
        {"title": "Redemption Song", "artist": "Bob Marley", "year": 1980, "language": "EN"},
        {"title": "Dust in the Wind", "artist": "Kansas", "year": 1977, "language": "EN"},
        {"title": "L'envie d'aimer", "artist": "Daniel Lévi", "year": 2000, "language": "FR"},
        {"title": "Au nom de la rose", "artist": "Moos", "year": 1999, "language": "FR"},
        {"title": "Si j'étais un homme", "artist": "Diane Tell", "year": 1981, "language": "FR"},
        {"title": "Quand on n'a que l'amour", "artist": "Jacques Brel", "year": 1956, "language": "FR"},
        {"title": "Freedom", "artist": "George Michael", "year": 1990, "language": "EN"}
    ],
    "AMOUR_TENDRESSE": [
        {"title": "I Will Always Love You", "artist": "Whitney Houston", "year": 1992, "language": "EN"},
        {"title": "L-O-V-E", "artist": "Nat King Cole", "year": 1965, "language": "EN"},
        {"title": "Can't Help Falling in Love", "artist": "Elvis Presley", "year": 1961, "language": "EN"},
        {"title": "All You Need Is Love", "artist": "The Beatles", "year": 1967, "language": "EN"},
        {"title": "Your Song", "artist": "Elton John", "year": 1970, "language": "EN"},
        {"title": "L'hymne à l'amour", "artist": "Édith Piaf", "year": 1950, "language": "FR"},
        {"title": "Je t'aime", "artist": "Lara Fabian", "year": 1996, "language": "FR"},
        {"title": "Savoir aimer", "artist": "Florent Pagny", "year": 1997, "language": "FR"},
        {"title": "Pour que tu m'aimes encore", "artist": "Céline Dion", "year": 1995, "language": "FR"},
        {"title": "Perfect", "artist": "Ed Sheeran", "year": 2017, "language": "EN"},
        {"title": "Crazy in Love", "artist": "Beyoncé", "year": 2003, "language": "EN"},
        {"title": "Endless Love", "artist": "Diana Ross & Lionel Richie", "year": 1981, "language": "EN"},
        {"title": "Shallow", "artist": "Lady Gaga & Bradley Cooper", "year": 2018, "language": "EN"},
        {"title": "La vie en rose", "artist": "Édith Piaf", "year": 1946, "language": "FR"},
        {"title": "Mon amour", "artist": "Slimane", "year": 2023, "language": "FR"},
        {"title": "Make You Feel My Love", "artist": "Adele", "year": 2008, "language": "EN"},
        {"title": "A Thousand Years", "artist": "Christina Perri", "year": 2011, "language": "EN"},
        {"title": "Just the Way You Are", "artist": "Bruno Mars", "year": 2010, "language": "EN"},
        {"title": "Love Me Tender", "artist": "Elvis Presley", "year": 1956, "language": "EN"},
        {"title": "Careless Whisper", "artist": "George Michael", "year": 1984, "language": "EN"}
    ],
    "FEMMES_POUVOIR": [
        {"title": "Respect", "artist": "Aretha Franklin", "year": 1967, "language": "EN"},
        {"title": "Run the World (Girls)", "artist": "Beyoncé", "year": 2011, "language": "EN"},
        {"title": "I'm Every Woman", "artist": "Whitney Houston", "year": 1992, "language": "EN"},
        {"title": "God Is a Woman", "artist": "Ariana Grande", "year": 2018, "language": "EN"},
        {"title": "Girls Just Want to Have Fun", "artist": "Cyndi Lauper", "year": 1983, "language": "EN"},
        {"title": "Femme libérée", "artist": "Cookie Dingler", "year": 1984, "language": "FR"},
        {"title": "Toutes les femmes de ta vie", "artist": "L5", "year": 2001, "language": "FR"},
        {"title": "Balance ton quoi", "artist": "Angèle", "year": 2018, "language": "FR"},
        {"title": "Superwoman", "artist": "Alicia Keys", "year": 2007, "language": "EN"},
        {"title": "Roar", "artist": "Katy Perry", "year": 2013, "language": "EN"},
        {"title": "Stronger", "artist": "Britney Spears", "year": 2000, "language": "EN"},
        {"title": "She Works Hard for the Money", "artist": "Donna Summer", "year": 1983, "language": "EN"},
        {"title": "Man! I Feel Like a Woman!", "artist": "Shania Twain", "year": 1997, "language": "EN"},
        {"title": "A Natural Woman", "artist": "Aretha Franklin", "year": 1967, "language": "EN"},
        {"title": "Sans contrefaçon", "artist": "Mylène Farmer", "year": 1987, "language": "FR"},
        {"title": "La Grenade", "artist": "Clara Luciani", "year": 2018, "language": "FR"},
        {"title": "Survivor", "artist": "Destiny's Child", "year": 2001, "language": "EN"},
        {"title": "Unstoppable", "artist": "Sia", "year": 2016, "language": "EN"},
        {"title": "No Scrubs", "artist": "TLC", "year": 1999, "language": "EN"},
        {"title": "You Gotta Be", "artist": "Des'ree", "year": 1994, "language": "EN"}
    ],
    "NATURE_PLANETE": [
        {"title": "Earth Song", "artist": "Michael Jackson", "year": 1995, "language": "EN"},
        {"title": "What a Wonderful World", "artist": "Louis Armstrong", "year": 1967, "language": "EN"},
        {"title": "Mercy Mercy Me (The Ecology)", "artist": "Marvin Gaye", "year": 1971, "language": "EN"},
        {"title": "Colors of the Wind", "artist": "Judy Kuhn / Pocahontas", "year": 1995, "language": "EN"},
        {"title": "Le pouvoir des fleurs", "artist": "Laurent Voulzy", "year": 1992, "language": "FR"},
        {"title": "Aux arbres citoyens", "artist": "Yannick Noah", "year": 2006, "language": "FR"},
        {"title": "Respire", "artist": "Mickey 3D", "year": 2003, "language": "FR"},
        {"title": "Big Yellow Taxi", "artist": "Joni Mitchell", "year": 1970, "language": "EN"},
        {"title": "Heal the World", "artist": "Michael Jackson", "year": 1991, "language": "EN"},
        {"title": "Beds Are Burning", "artist": "Midnight Oil", "year": 1987, "language": "EN"},
        {"title": "Hier encore", "artist": "Charles Aznavour", "year": 1964, "language": "FR"},
        {"title": "Radioactive", "artist": "Imagine Dragons", "year": 2012, "language": "EN"},
        {"title": "Paradis blanc", "artist": "Michel Berger", "year": 1990, "language": "FR"},
        {"title": "L'oiseau et l'enfant", "artist": "Marie Myriam", "year": 1977, "language": "FR"},
        {"title": "Circle of Life", "artist": "Elton John", "year": 1994, "language": "EN"},
        {"title": "Across the Universe", "artist": "The Beatles", "year": 1969, "language": "EN"},
        {"title": "Where Do the Children Play?", "artist": "Cat Stevens", "year": 1970, "language": "EN"},
        {"title": "Mother Nature's Son", "artist": "The Beatles", "year": 1968, "language": "EN"},
        {"title": "Don't Go Near the Water", "artist": "The Beach Boys", "year": 1971, "language": "EN"},
        {"title": "Fais comme l'oiseau", "artist": "Michel Fugain", "year": 1972, "language": "FR"}
    ],
    "FETE_DANSE": [
        {"title": "Celebration", "artist": "Kool & The Gang", "year": 1980, "language": "EN"},
        {"title": "Dancing Queen", "artist": "ABBA", "year": 1976, "language": "EN"},
        {"title": "Get Lucky", "artist": "Daft Punk ft. Pharrell Williams", "year": 2013, "language": "FR"},
        {"title": "Don't Stop 'Til You Get Enough", "artist": "Michael Jackson", "year": 1979, "language": "EN"},
        {"title": "Uptown Funk", "artist": "Mark Ronson ft. Bruno Mars", "year": 2014, "language": "EN"},
        {"title": "Nuit de folie", "artist": "Début de Soirée", "year": 1988, "language": "FR"},
        {"title": "Les démons de minuit", "artist": "Images", "year": 1986, "language": "FR"},
        {"title": "C'est la fête", "artist": "Michel Fugain", "year": 1973, "language": "FR"},
        {"title": "I Gotta Feeling", "artist": "The Black Eyed Peas", "year": 2009, "language": "EN"},
        {"title": "Happy", "artist": "Pharrell Williams", "year": 2013, "language": "EN"},
        {"title": "Dance Monkey", "artist": "Tones and I", "year": 2019, "language": "EN"},
        {"title": "Levitating", "artist": "Dua Lipa", "year": 2020, "language": "EN"},
        {"title": "Can't Stop the Feeling!", "artist": "Justin Timberlake", "year": 2016, "language": "EN"},
        {"title": "Shut Up and Dance", "artist": "Walk the Moon", "year": 2014, "language": "EN"},
        {"title": "Stayin' Alive", "artist": "Bee Gees", "year": 1977, "language": "EN"},
        {"title": "Le Rock d'Henriette", "artist": "Henri Salvador", "year": 1956, "language": "FR"},
        {"title": "Alors on danse", "artist": "Stromae", "year": 2009, "language": "FR"},
        {"title": "One More Time", "artist": "Daft Punk", "year": 2000, "language": "FR"},
        {"title": "September", "artist": "Earth, Wind & Fire", "year": 1978, "language": "EN"},
        {"title": "Y.M.C.A.", "artist": "Village People", "year": 1978, "language": "EN"}
    ],
    "VOYAGE_EVASION": [
        {"title": "Voyage, Voyage", "artist": "Desireless", "year": 1986, "language": "FR"},
        {"title": "Sweet Dreams (Are Made of This)", "artist": "Eurythmics", "year": 1983, "language": "EN"},
        {"title": "A Sky Full of Stars", "artist": "Coldplay", "year": 2014, "language": "EN"},
        {"title": "Fly Me to the Moon", "artist": "Frank Sinatra", "year": 1964, "language": "EN"},
        {"title": "La Seine", "artist": "Vanessa Paradis & -M-", "year": 2011, "language": "FR"},
        {"title": "Emmenez-moi", "artist": "Charles Aznavour", "year": 1967, "language": "FR"},
        {"title": "Over the Rainbow", "artist": "Israel Kamakawiwo'ole", "year": 1990, "language": "EN"},
        {"title": "Fast Car", "artist": "Tracy Chapman", "year": 1988, "language": "EN"},
        {"title": "On the Road Again", "artist": "Willie Nelson", "year": 1980, "language": "EN"},
        {"title": "Rêver", "artist": "Mylène Farmer", "year": 1995, "language": "FR"},
        {"title": "Lucid Dreams", "artist": "Juice WRLD", "year": 2018, "language": "EN"},
        {"title": "Dream On", "artist": "Aerosmith", "year": 1973, "language": "EN"},
        {"title": "Hotel California", "artist": "Eagles", "year": 1976, "language": "EN"},
        {"title": "Route 66", "artist": "Chuck Berry", "year": 1961, "language": "EN"},
        {"title": "Take Me Home, Country Roads", "artist": "John Denver", "year": 1971, "language": "EN"},
        {"title": "Castle on the Hill", "artist": "Ed Sheeran", "year": 2017, "language": "EN"},
        {"title": "Le Sud", "artist": "Nino Ferrer", "year": 1975, "language": "FR"},
        {"title": "Sailing", "artist": "Rod Stewart", "year": 1975, "language": "EN"},
        {"title": "Riders on the Storm", "artist": "The Doors", "year": 1971, "language": "EN"},
        {"title": "Good Vibrations", "artist": "The Beach Boys", "year": 1966, "language": "EN"}
    ],
    "SANTE_COURAGE": [
        {"title": "I Will Survive", "artist": "Gloria Gaynor", "year": 1978, "language": "EN"},
        {"title": "Eye of the Tiger", "artist": "Survivor", "year": 1982, "language": "EN"},
        {"title": "Stronger (What Doesn't Kill You)", "artist": "Kelly Clarkson", "year": 2011, "language": "EN"},
        {"title": "Fight Song", "artist": "Rachel Platten", "year": 2015, "language": "EN"},
        {"title": "Don't Stop Believin'", "artist": "Journey", "year": 1981, "language": "EN"},
        {"title": "L'envie", "artist": "Johnny Hallyday", "year": 1986, "language": "FR"},
        {"title": "Résiste", "artist": "France Gall", "year": 1981, "language": "FR"},
        {"title": "Chanter pour ceux qui sont loin de chez eux", "artist": "Michel Berger", "year": 1985, "language": "FR"},
        {"title": "Titanium", "artist": "David Guetta ft. Sia", "year": 2011, "language": "FR"},
        {"title": "The Show Must Go On", "artist": "Queen", "year": 1991, "language": "EN"},
        {"title": "Tubthumping", "artist": "Chumbawamba", "year": 1997, "language": "EN"},
        {"title": "Believer", "artist": "Imagine Dragons", "year": 2017, "language": "EN"},
        {"title": "Fix You", "artist": "Coldplay", "year": 2005, "language": "EN"},
        {"title": "Lean on Me", "artist": "Bill Withers", "year": 1972, "language": "EN"},
        {"title": "You've Got a Friend", "artist": "Carole King", "year": 1971, "language": "EN"},
        {"title": "Un homme debout", "artist": "Claudio Capéo", "year": 2016, "language": "FR"},
        {"title": "Et un jour une femme", "artist": "Florent Pagny", "year": 2000, "language": "FR"},
        {"title": "Brave", "artist": "Sara Bareilles", "year": 2013, "language": "EN"},
        {"title": "Rise Up", "artist": "Andra Day", "year": 2015, "language": "EN"},
        {"title": "We Are the Champions", "artist": "Queen", "year": 1977, "language": "EN"}
    ],
    "CINEMA_RADIO_ART": [
        {"title": "Radio Ga Ga", "artist": "Queen", "year": 1984, "language": "EN"},
        {"title": "Video Killed the Radio Star", "artist": "The Buggles", "year": 1979, "language": "EN"},
        {"title": "Bohemian Rhapsody", "artist": "Queen", "year": 1975, "language": "EN"},
        {"title": "My Heart Will Go On", "artist": "Céline Dion", "year": 1997, "language": "FR"},
        {"title": "Eye of the Tiger", "artist": "Survivor", "year": 1982, "language": "EN"},
        {"title": "Footloose", "artist": "Kenny Loggins", "year": 1984, "language": "EN"},
        {"title": "Ghostbusters", "artist": "Ray Parker Jr.", "year": 1984, "language": "EN"},
        {"title": "La Bamba", "artist": "Los Lobos", "year": 1987, "language": "ES"},
        {"title": "Take My Breath Away", "artist": "Berlin", "year": 1986, "language": "EN"},
        {"title": "Listen to Your Heart", "artist": "Roxette", "year": 1988, "language": "EN"},
        {"title": "La musique", "artist": "Nicoletta", "year": 1967, "language": "FR"},
        {"title": "Chanson populaire", "artist": "Claude François", "year": 1973, "language": "FR"},
        {"title": "Musique", "artist": "France Gall", "year": 1977, "language": "FR"},
        {"title": "Skyfall", "artist": "Adele", "year": 2012, "language": "EN"},
        {"title": "Stayin' Alive", "artist": "Bee Gees", "year": 1977, "language": "EN"},
        {"title": "Flashdance... What a Feeling", "artist": "Irene Cara", "year": 1983, "language": "EN"},
        {"title": "Fame", "artist": "Irene Cara", "year": 1980, "language": "EN"},
        {"title": "Kiss from a Rose", "artist": "Seal", "year": 1994, "language": "EN"},
        {"title": "Superstition", "artist": "Stevie Wonder", "year": 1972, "language": "EN"},
        {"title": "Purple Rain", "artist": "Prince", "year": 1984, "language": "EN"}
    ],
    "RIRE_BONHEUR": [
        {"title": "Don't Worry, Be Happy", "artist": "Bobby McFerrin", "year": 1988, "language": "EN"},
        {"title": "Smile", "artist": "Nat King Cole", "year": 1954, "language": "EN"},
        {"title": "C'est bon pour le moral", "artist": "La Compagnie Créole", "year": 1983, "language": "FR"},
        {"title": "Le banana split", "artist": "Lio", "year": 1979, "language": "FR"},
        {"title": "Il en faut peu pour être heureux", "artist": "Le Livre de la Jungle", "year": 1967, "language": "FR"},
        {"title": "Hakuna Matata", "artist": "Le Roi Lion", "year": 1994, "language": "FR"},
        {"title": "Walking on Sunshine", "artist": "Katrina and the Waves", "year": 1985, "language": "EN"},
        {"title": "Good Time", "artist": "Owl City & Carly Rae Jepsen", "year": 2012, "language": "EN"},
        {"title": "Hey Ya!", "artist": "OutKast", "year": 2003, "language": "EN"},
        {"title": "I'm a Believer", "artist": "The Monkees", "year": 1966, "language": "EN"},
        {"title": "You Can Call Me Al", "artist": "Paul Simon", "year": 1986, "language": "EN"},
        {"title": "La tribu de Dana", "artist": "Manau", "year": 1998, "language": "FR"},
        {"title": "Cotton Eye Joe", "artist": "Rednex", "year": 1994, "language": "EN"},
        {"title": "Macarena", "artist": "Los del Río", "year": 1993, "language": "ES"},
        {"title": "Le lion est mort ce soir", "artist": "Henri Salvador", "year": 1961, "language": "FR"},
        {"title": "Ce soir on danse sans toi", "artist": "Francois Feldman", "year": 1989, "language": "FR"},
        {"title": "Mambo No. 5", "artist": "Lou Bega", "year": 1999, "language": "EN"},
        {"title": "Cha Cha Slide", "artist": "DJ Casper", "year": 2000, "language": "EN"},
        {"title": "Aserejé (The Ketchup Song)", "artist": "Las Ketchup", "year": 2002, "language": "ES"},
        {"title": "Happy", "artist": "Pharrell Williams", "year": 2013, "language": "EN"}
    ]
}

# Cartographie officielle des Journées Mondiales clés (Mois-Jour -> Nom officiel, Thème, Icône)
OFFICIAL_WORLD_DAYS: dict[str, tuple[str, str, str]] = {
    "01-01": ("Journée mondiale de la Paix", "PAIX_HARMONIE", "☮️"),
    "01-04": ("Journée mondiale du Braille", "SANTE_COURAGE", "👁️"),
    "01-15": ("Journée mondiale de la Chapeau & Élégance", "CINEMA_RADIO_ART", "🎩"),
    "01-21": ("Journée internationale des Câlins", "AMOUR_TENDRESSE", "🤗"),
    "01-24": ("Journée internationale de l'Éducation", "RIRE_BONHEUR", "📚"),
    "01-27": ("Journée internationale de la Mémoire", "PAIX_HARMONIE", "🕯️"),
    "01-28": ("Journée européenne de la Protection des Données", "CINEMA_RADIO_ART", "🔒"),

    "02-02": ("Journée mondiale des Zones Humides & Nature", "NATURE_PLANETE", "🌊"),
    "02-04": ("Journée mondiale contre le Cancer", "SANTE_COURAGE", "🎗️"),
    "02-11": ("Journée internationale des Femmes de Science", "FEMMES_POUVOIR", "🔬"),
    "02-13": ("Journée mondiale de la Radio", "CINEMA_RADIO_ART", "📻"),
    "02-14": ("Journée internationale de l'Amour & Saint-Valentin", "AMOUR_TENDRESSE", "💖"),
    "02-20": ("Journée mondiale de la Justice Sociale", "PAIX_HARMONIE", "⚖️"),
    "02-21": ("Journée internationale de la Langue Maternelle", "VOYAGE_EVASION", "🗣️"),

    "03-03": ("Journée mondiale de la Vie Sauvage", "NATURE_PLANETE", "🦁"),
    "03-08": ("Journée internationale des Droits des Femmes", "FEMMES_POUVOIR", "👑"),
    "03-14": ("Journée internationale des Mathématiques & Pi", "CINEMA_RADIO_ART", "📐"),
    "03-15": ("Journée mondiale des Droits des Consommateurs", "SANTE_COURAGE", "🛍️"),
    "03-20": ("Journée internationale du Bonheur", "RIRE_BONHEUR", "😄"),
    "03-21": ("Journée mondiale de la Poésie", "VOYAGE_EVASION", "📜"),
    "03-22": ("Journée mondiale de l'Eau", "NATURE_PLANETE", "💧"),
    "03-27": ("Journée mondiale du Théâtre", "CINEMA_RADIO_ART", "🎭"),

    "04-01": ("Journée mondiale du Rire & Poisson d'avril", "RIRE_BONHEUR", "🐟"),
    "04-06": ("Journée internationale du Sport pour le Développement", "SANTE_COURAGE", "🏆"),
    "04-07": ("Journée mondiale de la Santé", "SANTE_COURAGE", "🩺"),
    "04-12": ("Journée internationale du Vol Spatial", "VOYAGE_EVASION", "🚀"),
    "04-15": ("Journée mondiale de l'Art", "CINEMA_RADIO_ART", "🎨"),
    "04-22": ("Journée mondiale de la Terre", "NATURE_PLANETE", "🌍"),
    "04-29": ("Journée internationale de la Danse", "FETE_DANSE", "💃"),
    "04-30": ("Journée internationale du Jazz", "FETE_DANSE", "🎷"),

    "05-01": ("Fête internationale du Travail", "SANTE_COURAGE", "🛠️"),
    "05-03": ("Journée mondiale de la Liberté de la Presse", "PAIX_HARMONIE", "📰"),
    "05-09": ("Journée de l'Europe & Harmonie", "PAIX_HARMONIE", "🇪🇺"),
    "05-15": ("Journée internationale des Familles", "AMOUR_TENDRESSE", "🏡"),
    "05-16": ("Journée internationale de la Lumière", "VOYAGE_EVASION", "💡"),
    "05-20": ("Journée mondiale des Abeilles", "NATURE_PLANETE", "🐝"),
    "05-22": ("Journée internationale de la Biodiversité", "NATURE_PLANETE", "🌱"),
    "05-25": ("Journée mondiale de l'Afrique & Rythmes", "FETE_DANSE", "🌍"),

    "06-01": ("Journée mondiale des Parents", "AMOUR_TENDRESSE", "👨‍👩‍👧"),
    "06-03": ("Journée mondiale de la Bicyclette", "NATURE_PLANETE", "🚲"),
    "06-05": ("Journée mondiale de l'Environnement", "NATURE_PLANETE", "🌳"),
    "06-08": ("Journée mondiale des Océans", "NATURE_PLANETE", "🌊"),
    "06-21": ("Fête de la Musique & Journée internationale de la Musique", "FETE_DANSE", "🎵"),
    "06-23": ("Journée olympique mondiale", "SANTE_COURAGE", "🥇"),
    "06-30": ("Journée internationale des Astéroïdes & Étoiles", "VOYAGE_EVASION", "☄️"),

    "07-06": ("Journée internationale du Baiser", "AMOUR_TENDRESSE", "💋"),
    "07-11": ("Journée mondiale de la Population", "PAIX_HARMONIE", "👥"),
    "07-17": ("Journée mondiale des Emojis & Sourires", "RIRE_BONHEUR", "😃"),
    "07-18": ("Journée internationale Nelson Mandela", "PAIX_HARMONIE", "🕊️"),
    "07-20": ("Journée internationale des Échecs", "CINEMA_RADIO_ART", "♟️"),
    "07-26": ("Journée internationale des Mangroves", "NATURE_PLANETE", "🌿"),
    "07-30": ("Journée internationale de l'Amitié", "AMOUR_TENDRESSE", "🤝"),

    "08-08": ("Journée internationale du Chat", "RIRE_BONHEUR", "🐱"),
    "08-09": ("Journée internationale des Peuples Autochtones", "VOYAGE_EVASION", "🪶"),
    "08-12": ("Journée internationale de la Jeunesse", "FETE_DANSE", "🎓"),
    "08-19": ("Journée mondiale de l'Aide Humanitaire", "PAIX_HARMONIE", "🤝"),
    "08-23": ("Journée internationale du Souvenir & Liberté", "PAIX_HARMONIE", "🗽"),
    "08-29": ("Journée internationale contre les Essais Nucléaires", "PAIX_HARMONIE", "☢️"),

    "09-05": ("Journée internationale de la Charité", "AMOUR_TENDRESSE", "❤️"),
    "09-08": ("Journée internationale de l'Alphabétisation", "CINEMA_RADIO_ART", "📖"),
    "09-15": ("Journée internationale de la Démocratie", "PAIX_HARMONIE", "🗳️"),
    "09-21": ("Journée internationale de la Paix", "PAIX_HARMONIE", "🕊️"),
    "09-27": ("Journée mondiale du Tourisme & Voyage", "VOYAGE_EVASION", "🧳"),
    "09-30": ("Journée internationale de la Traduction & Langues", "VOYAGE_EVASION", "🌐"),

    "10-01": ("Journée internationale de la Musique", "FETE_DANSE", "🎶"),
    "10-04": ("Journée mondiale des Animaux", "NATURE_PLANETE", "🐾"),
    "10-05": ("Journée mondiale des Enseignants", "CINEMA_RADIO_ART", "👩‍🏫"),
    "10-10": ("Journée mondiale de la Santé Mentale", "SANTE_COURAGE", "🧠"),
    "10-11": ("Journée internationale de la Fille", "FEMMES_POUVOIR", "👧"),
    "10-16": ("Journée mondiale de l'Alimentation", "SANTE_COURAGE", "🍞"),
    "10-24": ("Journée des Nations unies", "PAIX_HARMONIE", "🇺🇳"),
    "10-27": ("Journée mondiale du Patrimoine Audiovisuel", "CINEMA_RADIO_ART", "🎬"),
    "10-31": ("Fête d'Halloween & Légendes", "FETE_DANSE", "🎃"),

    "11-01": ("Journée mondiale du Véganisme", "NATURE_PLANETE", "🥗"),
    "11-10": ("Journée mondiale de la Science", "CINEMA_RADIO_ART", "🧪"),
    "11-16": ("Journée internationale de la Tolérance", "PAIX_HARMONIE", "🕊️"),
    "11-20": ("Journée internationale des Droits de l'Enfant", "AMOUR_TENDRESSE", "🧸"),
    "11-21": ("Journée mondiale de la Télévision", "CINEMA_RADIO_ART", "📺"),
    "11-25": ("Journée internationale pour l'Élimination de la Violence à l'Égard des Femmes", "FEMMES_POUVOIR", "💜"),

    "12-01": ("Journée mondiale de Lutte contre le SIDA", "SANTE_COURAGE", "🎗️"),
    "12-03": ("Journée internationale des Personnes Handicapées", "SANTE_COURAGE", "♿"),
    "12-05": ("Journée mondiale du Bénévolat", "AMOUR_TENDRESSE", "🤝"),
    "12-10": ("Journée internationale des Droits de l'Homme", "PAIX_HARMONIE", "🗽"),
    "12-18": ("Journée internationale des Migrants & Voyageurs", "VOYAGE_EVASION", "🧳"),
    "12-20": ("Journée internationale de la Solidarité Humaine", "PAIX_HARMONIE", "🤝"),
    "12-25": ("Fête de Noël & Magie de la Musique", "AMOUR_TENDRESSE", "🎄"),
    "12-31": ("Réveillon du Nouvel An & Grande Fête", "FETE_DANSE", "🎆")
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Génère le calendrier BlindBeat basé sur les Journées Mondiales (365 jours).")
    parser.add_argument("--output", default="artists_top500.json", help="Fichier JSON de sortie")
    parser.add_argument("--verbose", action="store_true", help="Mode verbeux")
    return parser.parse_args()


def get_default_theme_for_date(month: int, day: int) -> tuple[str, str, str]:
    """Attribue un thème par défaut équilibré pour les jours sans journée internationale spécifique."""
    themes_cycle = [
        ("FETE_DANSE", "Journée mondiale de la Musique & de la Joie", "🎵"),
        ("AMOUR_TENDRESSE", "Journée mondiale de la Tendresse & de l'Amitié", "💖"),
        ("PAIX_HARMONIE", "Journée internationale de la Sérénité & de la Paix", "🕊️"),
        ("NATURE_PLANETE", "Journée de la Planète & des Merveilles de la Nature", "🌿"),
        ("VOYAGE_EVASION", "Journée des Rêves & du Voyage Musical", "🚀"),
        ("SANTE_COURAGE", "Journée de l'Énergie & du Dépassement de Soi", "⚡"),
        ("CINEMA_RADIO_ART", "Journée des Arts, du Cinéma & de la Création", "🎨"),
        ("FEMMES_POUVOIR", "Journée de l'Inspiration & des Grandes Voix", "👑"),
        ("RIRE_BONHEUR", "Journée des Sourires & de la Bonne Humeur", "😄")
    ]
    idx = (month * 31 + day) % len(themes_cycle)
    return themes_cycle[idx][1], themes_cycle[idx][0], themes_cycle[idx][2]


def generate_wrong_answers(song: dict[str, Any], playlist_raw: list[dict[str, Any]], all_playlists: dict[str, list[dict[str, Any]]]) -> dict[str, list[Any]]:
    # 1. Mauvaises réponses pour l'Artiste
    other_artists = list({s["artist"] for s in playlist_raw if s["artist"] != song["artist"]})
    if len(other_artists) < 3:
        for pl in all_playlists.values():
            for s in pl:
                if s["artist"] != song["artist"] and s["artist"] not in other_artists:
                    other_artists.append(s["artist"])
    sorted_other_artists = sorted(other_artists, key=lambda a: hash(a + song["title"]))
    wrong_artists = sorted_other_artists[:3]

    # 2. Mauvaises réponses pour le Titre
    other_titles = list({s["title"] for s in playlist_raw if s["title"] != song["title"]})
    if len(other_titles) < 3:
        for pl in all_playlists.values():
            for s in pl:
                if s["title"] != song["title"] and s["title"] not in other_titles:
                    other_titles.append(s["title"])
    sorted_other_titles = sorted(other_titles, key=lambda t: hash(t + song["artist"]))
    wrong_titles = sorted_other_titles[:3]

    # 3. Mauvaises réponses pour l'Année
    correct_year = song["year"]
    candidate_years = [y for y in [correct_year - 4, correct_year + 3, correct_year - 7, correct_year + 5, correct_year - 2, correct_year + 8]
                       if y != correct_year and 1950 <= y <= 2025]
    wrong_years = candidate_years[:3]

    return {
        "wrong_artists": wrong_artists,
        "wrong_titles": wrong_titles,
        "wrong_years": wrong_years
    }


def fetch_deezer_info(title: str, artist: str, cache_root: Path, session: requests.Session) -> dict[str, Any]:
    key = f"{title.casefold()}_{artist.casefold()}"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    cache_path = cache_root / "deezer" / f"{digest}.json"

    if cache_path.exists():
        try:
            with cache_path.open("r", encoding="utf-8") as h:
                return json.load(h)
        except Exception:
            pass

    query = f"{title} {artist}"
    url = "https://api.deezer.com/search"
    try:
        res = session.get(url, params={"q": query, "limit": 1}, timeout=10)
        data = res.json()
        tracks = data.get("data", [])
        if tracks:
            t = tracks[0]
            info = {
                "deezer_id": t.get("id"),
                "preview": t.get("preview"),
                "cover": t.get("album", {}).get("cover_medium") or t.get("album", {}).get("cover")
            }
        else:
            info = {"deezer_id": None, "preview": None, "cover": None}
    except Exception as exc:
        LOG.warning("Erreur Deezer pour %s — %s: %s", title, artist, exc)
        info = {"deezer_id": None, "preview": None, "cover": None}

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("w", encoding="utf-8") as h:
        json.dump(info, h, ensure_ascii=False)

    return info


def build_world_days_calendar(cache_root: Path, session: requests.Session) -> dict[str, dict[str, Any]]:
    # Pré-récupérer les infos Deezer (preview MP3 et cover image) pour toutes les chansons uniques
    all_unique_pairs = {(s["title"], s["artist"]) for pl in THEME_PLAYLISTS.values() for s in pl}
    LOG.info("Enrichissement Deezer (extrait MP3 + image pochette) pour %s chansons uniques...", len(all_unique_pairs))
    deezer_cache: dict[tuple[str, str], dict[str, Any]] = {}
    for title, artist in all_unique_pairs:
        deezer_cache[(title, artist)] = fetch_deezer_info(title, artist, cache_root, session)

    calendar: dict[str, dict[str, Any]] = {}
    total_songs = 0

    for month_idx, days_count in enumerate(DAYS_IN_MONTH, 1):
        month_str = f"{month_idx:02d}"
        for day in range(1, days_count + 1):
            date_key = f"{month_str}-{day:02d}"

            if date_key in OFFICIAL_WORLD_DAYS:
                title, theme_key, icon = OFFICIAL_WORLD_DAYS[date_key]
            else:
                title, theme_key, icon = get_default_theme_for_date(month_idx, day)

            playlist_raw = THEME_PLAYLISTS.get(theme_key, THEME_PLAYLISTS["PAIX_HARMONIE"])

            # Formater les 20 chansons avec leur rang (#1 à #20), mauvaises réponses et métadonnées Deezer
            songs = []
            for rank, s in enumerate(playlist_raw, 1):
                wrong = generate_wrong_answers(s, playlist_raw, THEME_PLAYLISTS)
                dz = deezer_cache.get((s["title"], s["artist"]), {})
                songs.append({
                    "rank": rank,
                    "title": s["title"],
                    "artist": s["artist"],
                    "year": s["year"],
                    "language": s["language"],
                    "theme": theme_key,
                    "preview": dz.get("preview"),
                    "cover": dz.get("cover"),
                    "deezer_id": dz.get("deezer_id"),
                    "wrong_artists": wrong["wrong_artists"],
                    "wrong_titles": wrong["wrong_titles"],
                    "wrong_years": wrong["wrong_years"]
                })

            calendar[date_key] = {
                "date": date_key,
                "day_number": day,
                "month_number": month_idx,
                "month_name": MONTH_NAMES_FR[month_idx - 1],
                "world_day": title,
                "theme_key": theme_key,
                "icon": icon,
                "songs_count": len(songs),
                "songs": songs
            }
            total_songs += len(songs)

    LOG.info("Calendrier des 365 Journées Mondiales généré avec succès. Total chansons: %s", total_songs)
    return calendar


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    cache_root = Path("admin/.cache/top500")
    session = requests.Session()
    session.headers.update({
        "User-Agent": "BlindBeat-WorldDays/2.0 (contact: admin@blindbeat.app)",
        "Accept": "application/json",
    })

    try:
        calendar = build_world_days_calendar(cache_root, session)
    finally:
        session.close()

    # Construire la liste globale des chansons / classements pour la compatibilité avec la vue Classement
    unique_songs = []
    seen = set()
    rank = 1
    for day_data in calendar.values():
        for song in day_data["songs"]:
            key = (song["title"].casefold(), song["artist"].casefold())
            if key not in seen:
                seen.add(key)
                unique_songs.append({
                    "rank": rank,
                    "name": f"{song['title']} — {song['artist']}",
                    "title": song["title"],
                    "artist": song["artist"],
                    "type": "song",
                    "year": song["year"],
                    "language": song["language"],
                    "theme": song["theme"],
                    "preview": song.get("preview"),
                    "cover": song.get("cover"),
                    "deezer_id": song.get("deezer_id"),
                    "score": round(100.0 - (rank * 0.1), 2)
                })
                rank += 1

    document = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total_days": len(calendar),
        "songs_per_day": 20,
        "total_unique_songs": len(unique_songs),
        "ranking": unique_songs,
        "calendar": calendar
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temporary.replace(output_path)

    LOG.info("Sortie générée: %s (%s jours, %s chansons uniques)", output_path, len(calendar), len(unique_songs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
