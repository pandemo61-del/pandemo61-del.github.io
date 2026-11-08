/**
 * Règles métier de Whist partagées par l'application mobile et le client Web.
 * Ce module reste indépendant de React Native, du DOM et de Firebase.
 */

const isMisere = contract => String(contract?.id ?? '').includes('misere');

export function cartesJouables(main, pli, _atout) {
  if (main.length === 0) return [];
  const played = Array.isArray(pli) ? pli : (pli?.cartesJouees ?? []);
  if (played.length === 0) return main;
  const couleurDemandee = Array.isArray(pli)
    ? played[0]?.carte?.couleur
    : (pli?.couleurDemandee ?? played[0]?.carte?.couleur);
  if (!couleurDemandee) return main;
  const sameSuit = main.filter(card => card.couleur === couleurDemandee);
  return sameSuit.length > 0 ? sameSuit : main;
}

export function estPlusForte(challenger, actuelle, couleurDemandee, atout = null, ordreInverse = false) {
  if (challenger.estJoker) return true;
  if (actuelle.estJoker) return false;

  const force = value => ordreInverse ? 16 - value : value;
  const challengerValue = force(challenger.valeur);
  const currentValue = force(actuelle.valeur);

  if (atout) {
    const challengerTrump = challenger.couleur === atout;
    const currentTrump = actuelle.couleur === atout;
    if (challengerTrump && !currentTrump) return true;
    if (!challengerTrump && currentTrump) return false;
    if (challengerTrump && currentTrump) return challengerValue > currentValue;
  }

  if (challenger.couleur !== couleurDemandee) return false;
  if (actuelle.couleur !== couleurDemandee) return true;
  return challengerValue > currentValue;
}

export function determinerGagnant(pli, atout = null, ordreInverse = false) {
  const played = Array.isArray(pli) ? pli : (pli?.cartesJouees ?? []);
  const couleurDemandee = Array.isArray(pli)
    ? played[0]?.carte?.couleur
    : (pli?.couleurDemandee ?? played[0]?.carte?.couleur);
  if (played.length === 0) throw new Error('Pli vide');

  let best = played[0];
  for (let i = 1; i < played.length; i++) {
    const challenger = played[i];
    if (estPlusForte(challenger.carte, best.carte, couleurDemandee, atout, ordreInverse)) {
      best = challenger;
    }
  }
  return best.joueurId;
}

export function misereEchouee(plisTermines, joueurId) {
  return plisTermines.some(trick => trick.gagnantId === joueurId);
}

function cardIdentity(cardOrId) {
  const id = typeof cardOrId === 'string'
    ? cardOrId
    : (cardOrId?.id ?? '');
  const parts = id.replace('-', '_').split('_');
  const rawValue = typeof cardOrId === 'object' && cardOrId !== null
    ? cardOrId.valeur
    : parts[0];
  const aliases = { AS: 14, A: 14, ROI: 13, R: 13, KING: 13, DAME: 12, Q: 12, VALET: 11, J: 11 };
  const value = Number.isFinite(Number(rawValue)) ? Number(rawValue) : aliases[String(rawValue).toUpperCase()];
  const couleur = typeof cardOrId === 'object' && cardOrId !== null
    ? cardOrId.couleur
    : parts[1];
  return { value, couleur };
}

export function estRevelationPartenaire(carte, contrat) {
  if (!['demande', 'trou', 'trou_royal'].includes(contrat?.id) || !contrat?.asPartenaire) {
    return false;
  }
  const played = cardIdentity(carte);
  const called = cardIdentity(contrat.asPartenaire);
  return played.value === called.value && played.couleur === called.couleur;
}

export function compterPlisParJoueur(plisTermines, nbJoueurs = 4) {
  const compte = Object.fromEntries(Array.from({ length: nbJoueurs }, (_, id) => [id, 0]));
  for (const pli of plisTermines) {
    if (pli.gagnantId !== undefined) compte[pli.gagnantId] = (compte[pli.gagnantId] ?? 0) + 1;
  }
  return compte;
}

export function mancheTerminee(plisTermines, contrat) {
  if (!contrat) return plisTermines.length >= 13;
  if (isMisere(contrat) && misereEchouee(plisTermines, contrat.joueurId)) return true;
  return plisTermines.length >= (contrat.id === 'petite_misere' ? 12 : 13);
}

export function calculerReussiteWhist(contrat, plisParJoueur) {
  const partnerId = contrat.partenaireId;
  const tricks = (plisParJoueur[contrat.joueurId] ?? 0)
    + (partnerId !== undefined && partnerId !== null ? (plisParJoueur[partnerId] ?? 0) : 0);
  const objective = contrat.plisObjectif ?? contrat.obj ?? contrat.target ?? 0;
  const webZeroObjective = contrat.plisObjectif === undefined
    && (contrat.obj ?? contrat.target) === 0;
  return isMisere(contrat) || webZeroObjective ? tricks === 0 : tricks >= objective;
}

/**
 * Score nul-somme du Whist de Gand. Accepte le modèle mobile (pointsReussite,
 * sanAtout, plisObjectif) et le modèle Web historique (pts, sa, obj).
 */
export function calculerScoreWhistGand(contrat, plisParJoueur) {
  const ids = Object.keys(plisParJoueur).map(Number);
  const deltas = Object.fromEntries(ids.map(id => [id, 0]));
  const partnerId = contrat.partenaireId;
  const hasPartner = partnerId !== undefined && partnerId !== null
    && partnerId >= 0 && partnerId !== contrat.joueurId;
  const defenders = ids.filter(id => id !== contrat.joueurId && (!hasPartner || id !== partnerId));
  const bidderTricks = plisParJoueur[contrat.joueurId] ?? 0;
  const partnerTricks = hasPartner ? (plisParJoueur[partnerId] ?? 0) : 0;
  const teamTricks = bidderTricks + partnerTricks;
  const objective = contrat.plisObjectif ?? contrat.obj ?? contrat.target ?? 0;
  const success = calculerReussiteWhist(contrat, plisParJoueur);
  const basePoints = success
    ? (contrat.pointsReussite ?? contrat.pts ?? 0)
    : (contrat.pointsEchec ?? contrat.pts ?? 0);
  const noTrump = contrat.sanAtout ?? contrat.sa ?? false;
  let pointsPerDefender = basePoints;

  if (success && !noTrump && objective > 0 && contrat.id !== 'chelem') {
    pointsPerDefender += Math.max(0, teamTricks - objective);
  }

  const total = pointsPerDefender * defenders.length;
  if (success) {
    if (hasPartner) {
      deltas[contrat.joueurId] = Math.floor(total / 2);
      deltas[partnerId] = total - deltas[contrat.joueurId];
    } else {
      deltas[contrat.joueurId] = total;
    }
    for (const id of defenders) deltas[id] = -pointsPerDefender;
  } else {
    if (hasPartner) {
      deltas[contrat.joueurId] = -Math.floor(total / 2);
      deltas[partnerId] = -(total - Math.abs(deltas[contrat.joueurId]));
    } else {
      deltas[contrat.joueurId] = -total;
    }
    for (const id of defenders) deltas[id] = pointsPerDefender;
  }

  return {
    reussite: success,
    plisJoueurEtPartenaire: teamTricks,
    deltaScores: deltas,
    details: success
      ? `✓ ${contrat.nom} réussi (+${deltas[contrat.joueurId]} pts)`
      : `✗ ${contrat.nom} chute (−${Math.abs(deltas[contrat.joueurId])} pts)`,
    bidderId: contrat.joueurId,
    partnerId: hasPartner ? partnerId : -1,
    objective,
    points: basePoints,
    teamTricks,
    defenseIds: defenders,
  };
}
