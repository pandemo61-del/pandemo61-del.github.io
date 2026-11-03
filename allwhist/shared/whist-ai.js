const SUITS = ['COEUR', 'CARREAU', 'TREFLE', 'PIQUE'];
const HONOR_RISK = { 14: 12, 13: 7, 12: 4, 11: 2.5, 10: 1, 9: 0.5 };

export const WHIST_AI_VERSION = '1.3.1';

function contractPriority(contract) {
  return contract?.priorite ?? contract?.prio ?? -1;
}

function cardsBySuit(hand) {
  const bySuit = Object.fromEntries(SUITS.map(suit => [suit, []]));
  for (const card of hand) {
    if (bySuit[card.couleur]) bySuit[card.couleur].push(card.valeur);
  }
  for (const values of Object.values(bySuit)) values.sort((a, b) => b - a);
  return bySuit;
}

function has(values, value) {
  return values.includes(value);
}

function honorTricks(values) {
  const length = values.length;
  let tricks = 0;
  if (has(values, 14)) tricks += 1.0;
  if (has(values, 13)) tricks += length >= 2 ? 0.7 : 0.3;
  if (has(values, 12)) tricks += length >= 3 ? 0.42 : 0.12;
  if (has(values, 11)) tricks += length >= 4 ? 0.24 : 0.06;
  if (has(values, 10)) tricks += length >= 5 ? 0.12 : 0.02;
  if (has(values, 14) && has(values, 13) && has(values, 12)) tricks += 0.35;
  else if (has(values, 13) && has(values, 12) && has(values, 11)) tricks += 0.2;
  return tricks;
}

function evaluateTrump(hand, trump) {
  const bySuit = cardsBySuit(hand);
  const trumps = bySuit[trump];
  if (trumps.length === 13) {
    return {
      suit: trump,
      length: 13,
      controls: 4,
      expectedTricks: 13,
      safeTricks: 13,
      ceilingTricks: 13,
    };
  }
  const lengthBonus = [0, 0, 0, 0, 0.2, 0.65, 1.2, 1.9, 2.8, 3.8, 4.9, 6.1, 7.4, 8.8][trumps.length] ?? (trumps.length * 0.7);
  let expected = honorTricks(trumps) + lengthBonus;
  let controls = has(trumps, 14) ? 1 : 0;
  let shortness = 0;

  for (const suit of SUITS) {
    if (suit === trump) continue;
    const values = bySuit[suit];
    expected += honorTricks(values);
    if (has(values, 14)) controls += 1;
    if (values.length === 0) shortness += 0.75;
    else if (values.length === 1) shortness += 0.45;
    else if (values.length === 2) shortness += 0.15;
  }

  expected += shortness * Math.min(1, trumps.length / 5);
  expected = Math.min(hand.length, expected);
  const uncertainty = Math.max(0.15, 0.55 - trumps.length * 0.05 - controls * 0.04);
  return {
    suit: trump,
    length: trumps.length,
    controls,
    expectedTricks: expected,
    safeTricks: Math.max(0, expected - uncertainty),
    ceilingTricks: Math.min(hand.length, expected + 0.75),
  };
}

function bestTrump(hand) {
  return SUITS
    .map(suit => evaluateTrump(hand, suit))
    .sort((a, b) =>
      b.safeTricks - a.safeTricks ||
      b.controls - a.controls ||
      b.length - a.length
    )[0];
}

function cardMisereRisk(card, bySuit) {
  const values = bySuit[card.couleur];
  const lowerCards = values.filter(value => value < card.valeur).length;
  const length = values.length;
  const base = HONOR_RISK[card.valeur] ?? 0;
  if (!base) return 0;
  const coverFactor = Math.max(0.28, 1 - lowerCards * 0.13 - Math.max(0, length - 4) * 0.06);
  const shortPenalty = length === 1 ? 1.25 : length === 2 ? 1.08 : 1;
  return base * coverFactor * shortPenalty;
}

function misereRisk(hand) {
  const bySuit = cardsBySuit(hand);
  let risk = hand.reduce((sum, card) => sum + cardMisereRisk(card, bySuit), 0);
  for (const values of Object.values(bySuit)) {
    if (values.length === 0) risk -= 2.0;
    else if (values.length === 1 && values[0] <= 9) risk -= 1.2;
    else if (values.length === 2 && values[0] <= 10) risk -= 0.6;
    else if (values.length >= 5 && values[0] <= 11) risk -= 0.8;
  }
  return Math.max(0, risk);
}

export function chooseMisereDiscard(hand) {
  if (!hand.length) return undefined;
  return [...hand]
    .map(card => ({ card, remainingRisk: misereRisk(hand.filter(candidate => candidate !== card)) }))
    .sort((a, b) => a.remainingRisk - b.remainingRisk || b.card.valeur - a.card.valeur)[0].card;
}

function availableContract(contracts, id, hand, currentBid, playerId) {
  const contract = contracts.find(candidate => candidate.id === id);
  if (!contract) return null;
  if (contract.disponibleSi && !contract.disponibleSi(hand, currentBid, playerId)) return null;
  return contract;
}

function decisionFor(contract, trump, calledCard) {
  return {
    action: 'enchere',
    contratId: contract.id,
    atout: contract.sanAtout ? undefined : trump,
    asPartenaire: calledCard,
  };
}

function difficultyMargin(level) {
  return { facile: 0.4, moyen: 0.15, expert: 0 }[level] ?? 0.15;
}

function partnerContribution(best, hand) {
  const bySuit = cardsBySuit(hand);
  const voids = Object.values(bySuit).filter(values => values.length === 0).length;
  const unsupportedHonors = Object.values(bySuit).reduce((count, values) =>
    count + (has(values, 13) && values.length === 1 ? 1 : 0) +
    (has(values, 12) && values.length <= 2 && !has(values, 14) && !has(values, 13) ? 1 : 0), 0);
  return Math.max(2.7, Math.min(3.8,
    3.0 + voids * 0.15 + best.length * 0.1 - unsupportedHonors * 0.2
  ));
}

function canSupportProposal(hand, trump, level) {
  const bySuit = cardsBySuit(hand);
  const values = bySuit[trump] ?? [];
  const length = values.length;
  const topHonors = values.filter(value => value >= 13).length;
  const outsideAces = SUITS
    .filter(suit => suit !== trump)
    .reduce((count, suit) => count + (has(bySuit[suit], 14) ? 1 : 0), 0);
  const evaluation = evaluateTrump(hand, trump);
  const margin = difficultyMargin(level);

  if (length >= 5) return evaluation.safeTricks + outsideAces * 0.25 >= 3.0 + margin;
  if (length >= 4 && (topHonors >= 1 || outsideAces >= 1)) return evaluation.safeTricks >= 2.7 + margin;
  if (length >= 3 && topHonors >= 2) return true;
  if (length >= 3 && topHonors >= 1 && outsideAces >= 2) return true;
  return false;
}

function successUtility(safeTricks, target, reward, margin) {
  const surplus = safeTricks - target - margin;
  return Math.max(0, surplus) * 1.5 + reward * 4.0 - Math.max(0, -surplus) * 5;
}

export function chooseWhistBid(hand, currentBid, level, playerId, contracts) {
  const currentPriority = contractPriority(currentBid);
  const margin = difficultyMargin(level);
  const aces = hand.filter(card => card.valeur === 14);

  if (aces.length === 4 && currentPriority < 7.5) {
    const contract = availableContract(contracts, 'trou_royal', hand, currentBid, playerId);
    if (contract && contractPriority(contract) > currentPriority) {
      return decisionFor(contract, 'COEUR', '13_COEUR');
    }
  }
  if (aces.length === 3 && currentPriority < 7) {
    const calledSuit = SUITS.find(suit => !aces.some(card => card.couleur === suit));
    const contract = availableContract(contracts, 'trou', hand, currentBid, playerId);
    if (contract && contractPriority(contract) > currentPriority) {
      return decisionFor(contract, calledSuit, calledSuit ? `14_${calledSuit}` : undefined);
    }
  }

  if (currentBid?.id === 'propose' && currentBid.joueurId !== playerId) {
    const contract = availableContract(contracts, 'emballe', hand, currentBid, playerId);
    if (contract && contractPriority(contract) > currentPriority && canSupportProposal(hand, currentBid.atout, level)) {
      return decisionFor(contract, currentBid.atout);
    }
  }

  const best = bestTrump(hand);
  const candidates = [];
  const soloContracts = [
    ['solo_6', 5.75, 1, 4, 0],
    ['solo_7', 6.75, 2, 5, 0],
    ['solo_8', 7.75, 3, 5, 2],
    ['abondance_9', 8.8, 4, 6, 2],
    ['abondance_10', 9.75, 5, 6, 3],
    ['abondance_11', 10.75, 6, 6, 3],
    ['abondance_12', 11.7, 7, 7, 3],
    ['chelem', 12.6, 9, 7, 4],
  ];

  for (const [id, target, reward, minLength, minControls] of soloContracts) {
    const contract = availableContract(contracts, id, hand, currentBid, playerId);
    if (!contract || contractPriority(contract) <= currentPriority) continue;
    if (best.length < minLength || best.controls < minControls) continue;
    const utility = successUtility(best.safeTricks, target, reward, margin);
    if (utility > 0) candidates.push({ contract, trump: best.suit, utility });
  }

  const rawRisk = misereRisk(hand);
  const discard = chooseMisereDiscard(hand);
  const discardRisk = discard ? misereRisk(hand.filter(card => card !== discard)) : rawRisk;
  const honorsCount = hand.filter(card => card.valeur >= 11).length;
  const acesCount = hand.filter(card => card.valeur === 14).length;
  const kingsCount = hand.filter(card => card.valeur === 13).length;

  const misereOptions = [
    ['petite_misere', discardRisk, 5.2, 2.0, acesCount === 0 && honorsCount <= 2],
    ['misere', rawRisk, 3.2, 3.0, acesCount === 0 && kingsCount <= 1 && honorsCount <= 1],
    ['misere_ouverte', rawRisk, 0.5, 5.0, acesCount === 0 && kingsCount === 0 && honorsCount === 0],
  ];
  for (const [id, risk, maxRisk, reward, allowed] of misereOptions) {
    const contract = availableContract(contracts, id, hand, currentBid, playerId);
    if (!contract || contractPriority(contract) <= currentPriority) continue;
    if (!allowed) continue;
    const utility = (maxRisk - risk) * 0.8 + reward - margin * 2;
    if (risk <= maxRisk && utility > 0) candidates.push({ contract, trump: null, utility });
  }

  const proposal = availableContract(contracts, 'propose', hand, currentBid, playerId);
  if (proposal && contractPriority(proposal) > currentPriority && best.length >= 4 && best.safeTricks < 10) {
    const bySuit = cardsBySuit(hand);
    const trumpValues = bySuit[best.suit];
    const conditions = [
      has(trumpValues, 14),
      has(trumpValues, 13) && trumpValues.length >= 2,
      trumpValues.length >= 5,
      SUITS.some(suit => suit !== best.suit && has(bySuit[suit], 14)),
    ].filter(Boolean).length;
    const teamEstimate = best.safeTricks + partnerContribution(best, hand);
    const utility = (teamEstimate - 7.6 - margin) * 2.4 + 1.5;
    if (conditions >= 2 && best.safeTricks >= 4.2 - margin && utility > 0) {
      candidates.push({ contract: proposal, trump: best.suit, utility });
    }
  }

  candidates.sort((a, b) => b.utility - a.utility || contractPriority(b.contract) - contractPriority(a.contract));
  const selected = candidates[0];
  return selected ? decisionFor(selected.contract, selected.trump) : { action: 'passe' };
}

function beats(challenger, current, ledSuit, trump) {
  if (challenger.estJoker) return true;
  if (current.estJoker) return false;
  if (trump) {
    const challengerTrump = challenger.couleur === trump;
    const currentTrump = current.couleur === trump;
    if (challengerTrump !== currentTrump) return challengerTrump;
    if (challengerTrump) return challenger.valeur > current.valeur;
  }
  if (challenger.couleur !== ledSuit) return false;
  if (current.couleur !== ledSuit) return true;
  return challenger.valeur > current.valeur;
}

function winningPlay(trick, trump) {
  let best = trick.cartesJouees[0];
  const ledSuit = trick.couleurDemandee ?? best.carte.couleur;
  for (let i = 1; i < trick.cartesJouees.length; i++) {
    const play = trick.cartesJouees[i];
    if (beats(play.carte, best.carte, ledSuit, trump)) best = play;
  }
  return best;
}

function calledCardMatches(card, called) {
  if (!called) return false;
  if (typeof called === 'object') {
    return card.valeur === called.valeur && card.couleur === called.couleur;
  }
  const match = String(called).match(/^(\d+)[_-](COEUR|CARREAU|TREFLE|PIQUE)$/);
  return !!match && card.valeur === Number(match[1]) && card.couleur === match[2];
}

function revealedPartner(contract, tricks, currentTrick, hand, playerId) {
  if (Number.isInteger(contract.partenaireId) && contract.partenaireId >= 0 && contract.partenaireId < 4) {
    return contract.partenaireId;
  }
  if (!contract.asPartenaire) return undefined;
  if (hand.some(card => calledCardMatches(card, contract.asPartenaire))) return playerId;
  const plays = [...tricks.flatMap(trick => trick.cartesJouees ?? []), ...(currentTrick?.cartesJouees ?? [])];
  return plays.find(play => calledCardMatches(play.carte, contract.asPartenaire))?.joueurId;
}

function teamFor(contract, partnerId, playerId, opponentId) {
  if (!contract) return (playerId % 2) === (opponentId % 2);
  const bidderId = contract.joueurId;
  if (contract.seul || String(contract.id).includes('misere')) {
    return playerId !== bidderId && opponentId !== bidderId;
  }
  if (playerId === bidderId || playerId === partnerId) {
    return opponentId === bidderId || opponentId === partnerId;
  }
  if (partnerId === undefined) return opponentId !== bidderId;
  return opponentId !== bidderId && opponentId !== partnerId;
}

function discardCard(cards, trump, shedsDangerous = false) {
  return [...cards].sort((a, b) => {
    const aTrump = a.couleur === trump ? 1 : 0;
    const bTrump = b.couleur === trump ? 1 : 0;
    if (aTrump !== bTrump) return aTrump - bTrump;
    return shedsDangerous ? b.valeur - a.valeur : a.valeur - b.valeur;
  })[0];
}

function exhaustedSuits(solisteId, completedTricks, currentTrick) {
  const exhausted = new Set();
  for (const trick of [...completedTricks, ...(currentTrick?.cartesJouees?.length ? [currentTrick] : [])]) {
    const ledSuit = trick.couleurDemandee ?? trick.cartesJouees?.[0]?.carte?.couleur;
    const soloPlay = trick.cartesJouees?.find(play => play.joueurId === solisteId);
    if (ledSuit && soloPlay && soloPlay.carte.couleur !== ledSuit) exhausted.add(ledSuit);
  }
  return exhausted;
}
function isMisereContract(contract) {
  return [
    'petite_misere',
    'misere',
    'misere_ouverte',
  ].includes(contract?.id);
}

function cardRelativeRank(card, cards) {
  if (!cards.length) return 0.5;

  const sorted = [...cards].sort((a, b) => a.valeur - b.valeur);
  const index = sorted.findIndex(candidate => sameCard(candidate, card));

  if (index < 0) return 0.5;
  if (sorted.length === 1) return 0.5;

  return index / (sorted.length - 1);
}

function declarerSuitKnowledge(solisteId, completedTricks, currentTrick) {
  const knowledge = Object.fromEntries(
    SUITS.map(suit => [
      suit,
      {
        exhausted: false,
        playedValues: [],
        highestPlayed: undefined,
        lowestPlayed: undefined,
      },
    ])
  );

  const tricks = [
    ...(completedTricks ?? []),
    ...(currentTrick?.cartesJouees?.length ? [currentTrick] : []),
  ];

  for (const trick of tricks) {
    const ledSuit =
      trick.couleurDemandee ??
      trick.cartesJouees?.[0]?.carte?.couleur;

    if (!ledSuit) continue;

    const solistPlay = trick.cartesJouees?.find(
      play => play.joueurId === solisteId
    );

    if (!solistPlay?.carte) continue;

    if (solistPlay.carte.couleur !== ledSuit) {
      knowledge[ledSuit].exhausted = true;
      continue;
    }

    const suitKnowledge = knowledge[ledSuit];

    suitKnowledge.playedValues.push(
      solistPlay.carte.valeur
    );

    suitKnowledge.highestPlayed =
      suitKnowledge.highestPlayed === undefined
        ? solistPlay.carte.valeur
        : Math.max(
          suitKnowledge.highestPlayed,
          solistPlay.carte.valeur
        );

    suitKnowledge.lowestPlayed =
      suitKnowledge.lowestPlayed === undefined
        ? solistPlay.carte.valeur
        : Math.min(
          suitKnowledge.lowestPlayed,
          solistPlay.carte.valeur
        );
  }

  return knowledge;
}

function evaluateMisereDefenseLead(
  card,
  hand,
  contract,
  completedTricks,
  currentTrick
) {
  const cardsInSuit = hand
    .filter(candidate => candidate.couleur === card.couleur)
    .sort((a, b) => a.valeur - b.valeur);

  const relativeRank = cardRelativeRank(
    card,
    cardsInSuit
  );

  const lowerCards = cardsInSuit.filter(
    candidate => candidate.valeur < card.valeur
  );

  const higherCards = cardsInSuit.filter(
    candidate => candidate.valeur > card.valeur
  );

  const knowledge = declarerSuitKnowledge(
    contract?.joueurId,
    completedTricks,
    currentTrick
  );

  const suitKnowledge =
    knowledge[card.couleur] ?? {
      exhausted: false,
      playedValues: [],
      highestPlayed: undefined,
      lowestPlayed: undefined,
    };

  let score = 0;

  /*
   * Correction principale issue des simulations.
   *
   * Une carte située dans le haut de la couleur est fortement
   * pénalisée. Auparavant, les défenseurs choisissaient directement
   * la carte la plus haute à l'entame.
   */
  score -= relativeRank * 32;

  /*
   * Une couleur longue permet de continuer la pression sans
   * consommer immédiatement toutes les reprises de main.
   */
  score += Math.min(6, cardsInSuit.length) * 2.4;

  /*
   * Favoriser clairement une petite carte d'une couleur longue.
   */
  if (
    cardsInSuit.length >= 4 &&
    relativeRank <= 0.25
  ) {
    score += 14;
  }

  if (
    cardsInSuit.length >= 3 &&
    relativeRank <= 0.5
  ) {
    score += 5;
  }

  /*
   * Ne pas entamer un honneur lorsqu'une carte inférieure de la
   * même couleur est disponible.
   */
  if (
    card.valeur >= 11 &&
    lowerCards.length > 0
  ) {
    score -= 20;
  }

  /*
   * Les As, Rois et Dames courts sont particulièrement dangereux.
   * Ils donnent inutilement la main au défenseur et libèrent les
   * petites cartes du déclarant.
   */
  if (
    card.valeur === 14 &&
    cardsInSuit.length <= 3
  ) {
    score -= 22;
  }

  if (
    card.valeur === 13 &&
    cardsInSuit.length <= 2
  ) {
    score -= 17;
  }

  if (
    card.valeur === 12 &&
    cardsInSuit.length === 1
  ) {
    score -= 12;
  }

  /*
   * Conserver une reprise reste utile. Une carte haute n'est donc
   * pas interdite, mais elle ne doit pas être jouée tant qu'une
   * carte basse de la même couleur permet de poursuivre la pression.
   */
  if (
    card.valeur >= 12 &&
    higherCards.length === 0 &&
    lowerCards.length >= 2
  ) {
    score -= 8;
  }

  /*
   * Ne pas rejouer une couleur dans laquelle le déclarant a déjà
   * montré qu'il était vide. Il pourrait alors se défaire librement
   * d'une carte dangereuse.
   */
  if (suitKnowledge.exhausted) {
    score -= 40;
  }

  /*
   * Si le déclarant a déjà joué une carte relativement haute dans
   * cette couleur, continuer avec une petite carte peut l'obliger
   * à conserver ou à jouer une autre carte dangereuse.
   */
  if (
    suitKnowledge.highestPlayed !== undefined &&
    suitKnowledge.highestPlayed >= 10 &&
    relativeRank <= 0.25
  ) {
    score += 10;
  }

  /*
   * En Misère Ouverte, la main du déclarant peut être fournie dans
   * le contrat. On favorise alors les couleurs contenant encore un
   * honneur dangereux chez le déclarant.
   */
  const visibleHand =
    contract?.mainVisible ??
    contract?.mainSolisteVisible ??
    contract?.cartesVisibles;

  if (
    contract?.id === 'misere_ouverte' &&
    Array.isArray(visibleHand)
  ) {
    const declarerCardsInSuit = visibleHand.filter(
      candidate => candidate.couleur === card.couleur
    );

    const declarerHighest = declarerCardsInSuit.reduce(
      (highest, candidate) =>
        Math.max(highest, candidate.valeur),
      0
    );

    if (declarerCardsInSuit.length === 0) {
      score -= 45;
    } else if (declarerHighest >= 12) {
      score += 18;
    } else if (declarerHighest >= 10) {
      score += 10;
    }

    if (
      declarerCardsInSuit.length >= 3 &&
      relativeRank <= 0.25
    ) {
      score += 8;
    }
  }

  return score;
}

function chooseMisereDefenseLead(
  legal,
  hand,
  contract,
  completedTricks,
  currentTrick
) {
  if (!legal.length) return undefined;

  return [...legal]
    .map(card => ({
      card,
      score: evaluateMisereDefenseLead(
        card,
        hand,
        contract,
        completedTricks,
        currentTrick
      ),
    }))
    .sort((a, b) =>
      b.score - a.score ||
      a.card.valeur - b.card.valeur ||
      SUITS.indexOf(a.card.couleur) -
        SUITS.indexOf(b.card.couleur) ||
      cardKey(a.card).localeCompare(
        cardKey(b.card)
      )
    )[0].card;
}


const DEFAULT_PLAY_OPTIONS = Object.freeze({
  level: 'moyen',
  personality: 'balanced',
  deterministic: true,
  alternativesLimit: 3,
});

const REASON_EXPLANATIONS = Object.freeze({
  ONLY_LEGAL_CARD: 'Cette carte est votre seule possibilité légale.',
  FOLLOW_SUIT: 'Vous devez suivre la couleur demandée.',
  LOW_MISERE_LEAD: 'En misère, une petite carte réduit le risque de remporter le pli.',
  PRESSURE_MISERE: 'Cette carte met le soliste en misère sous pression.',
  FORCE_MISERE_WIN: 'Cette carte reprend le pli au soliste et limite ses possibilités de défausse.',
  SHED_DANGEROUS_HONOR: 'Cette défausse élimine un honneur dangereux pour la suite de la misère.',
  CALL_PARTNER: 'Cette entame recherche la couleur de la carte appelée afin de révéler le partenaire.',
  SAFE_OPENING_LEAD: 'Cette entame limite le nombre de cartes supérieures encore inconnues.',
  PRESERVE_TRUMP: 'Cette carte préserve les atouts pour un pli plus important.',
  REVEAL_PARTNER: 'La carte appelée doit être jouée afin de révéler le partenaire au bon moment.',
  PARTNER_WINNING: 'Votre partenaire maîtrise déjà le pli. Une petite carte préserve vos forces.',
  CHEAPEST_WINNER: 'Cette carte est la plus petite carte permettant actuellement de remporter le pli.',
  SAFE_DISCARD: 'Cette défausse préserve les cartes les plus utiles.',
  CANNOT_WIN: 'Aucune carte légale ne peut remporter le pli. Cette carte limite la perte de valeur.',
  AGGRESSIVE_CONTROL: 'Ce choix cherche à prendre la main et à conserver l’initiative.',
  CONSERVATIVE_SAVE: 'Ce choix protège les honneurs et limite les dépenses inutiles.',
  BALANCED_PLAY: 'Ce choix offre le meilleur équilibre entre le pli actuel et les plis suivants.',
});

function normalizePlayOptions(options = {}) {
  const rawLevel = String(options.level ?? DEFAULT_PLAY_OPTIONS.level).toLowerCase();
  const rawPersonality = String(options.personality ?? DEFAULT_PLAY_OPTIONS.personality).toLowerCase();
  const levelAliases = {
    facile: 'facile', easy: 'facile', beginner: 'facile', debutant: 'facile', 'débutant': 'facile',
    moyen: 'moyen', medium: 'moyen', intermediate: 'moyen', intermediaire: 'moyen', 'intermédiaire': 'moyen',
    expert: 'expert', hard: 'expert',
  };
  const personalityAliases = {
    prudent: 'conservative', prudente: 'conservative', conservative: 'conservative',
    conservateur: 'conservative', conservatrice: 'conservative',
    balanced: 'balanced', equilibre: 'balanced', 'équilibré': 'balanced', equilibree: 'balanced', 'équilibrée': 'balanced',
    agressif: 'aggressive', agressive: 'aggressive', aggressive: 'aggressive',
  };
  return {
    level: levelAliases[rawLevel] ?? DEFAULT_PLAY_OPTIONS.level,
    personality: personalityAliases[rawPersonality] ?? DEFAULT_PLAY_OPTIONS.personality,
    deterministic: options.deterministic ?? DEFAULT_PLAY_OPTIONS.deterministic,
    alternativesLimit: Math.max(0, Math.min(5,
      Number.isFinite(Number(options.alternativesLimit))
        ? Math.trunc(Number(options.alternativesLimit))
        : DEFAULT_PLAY_OPTIONS.alternativesLimit)),
  };
}

function cardKey(card) {
  return card?.id ?? (card ? `${card.valeur}_${card.couleur}` : '');
}

function sameCard(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.id !== undefined && right.id !== undefined) return left.id === right.id;
  return left.valeur === right.valeur && left.couleur === right.couleur && !!left.estJoker === !!right.estJoker;
}

function legalWhistCards(hand, trick) {
  if (!hand.length) return [];
  const ledSuit = trick?.couleurDemandee ?? trick?.cartesJouees?.[0]?.carte?.couleur;
  if (!ledSuit) return [...hand];
  const suited = hand.filter(card => card.couleur === ledSuit);
  return suited.length ? suited : [...hand];
}

function visibleCards(playedCards, completedTricks, currentTrick) {
  const result = [];
  const seen = new Set();
  const add = card => {
    if (!card) return;
    const key = cardKey(card);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(card);
  };
  for (const card of playedCards ?? []) add(card);
  for (const done of completedTricks ?? []) for (const play of done.cartesJouees ?? []) add(play.carte);
  for (const play of currentTrick?.cartesJouees ?? []) add(play.carte);
  return result;
}

function countUnseenHigher(card, hand, visible) {
  if (card.estJoker) return 0;
  const knownHigher = [...hand, ...visible].filter(candidate =>
    !candidate.estJoker && candidate.couleur === card.couleur && candidate.valeur > card.valeur
  ).length;
  return Math.max(0, 14 - card.valeur - knownHigher);
}

function isHonor(card) {
  return !card.estJoker && card.valeur >= 11;
}

function contextualExplanation(reasonCode, context = {}) {
  const { card, ledSuit, currentWinner, unseenHigher } = context;
  if (reasonCode === 'FOLLOW_SUIT' && ledSuit) {
    return `Vous devez suivre ${ledSuit.toLowerCase()}. Cette carte reste une option légale et économique.`;
  }
  if (reasonCode === 'CHEAPEST_WINNER' && currentWinner?.carte) {
    return `${card.valeur} de ${card.couleur.toLowerCase()} est la plus petite carte recommandée pour dépasser ${currentWinner.carte.valeur} de ${currentWinner.carte.couleur.toLowerCase()}.`;
  }
  if (reasonCode === 'SAFE_OPENING_LEAD') {
    return unseenHigher === 0
      ? 'Cette carte est maîtresse dans sa couleur parmi les cartes encore inconnues.'
      : `Cette entame ne laisse que ${unseenHigher} carte${unseenHigher > 1 ? 's' : ''} supérieure${unseenHigher > 1 ? 's' : ''} encore inconnue${unseenHigher > 1 ? 's' : ''}.`;
  }
  return REASON_EXPLANATIONS[reasonCode] ?? REASON_EXPLANATIONS.BALANCED_PLAY;
}

function playersRemainingAfterCurrent(playerId, trick) {
  const remainingCount = Math.max(0, 3 - (trick?.cartesJouees?.length ?? 0));
  return Array.from({ length: remainingCount }, (_, index) => (playerId + index + 1) % 4);
}

function preferredLegacyDecision(
  hand,
  playerId,
  trick,
  trump,
  contract,
  playedCards,
  completedTricks
) {
  const legal = legalWhistCards(hand, trick);

  if (!legal.length) {
    return {
      card: undefined,
      reasonCode: 'NO_LEGAL_CARD',
    };
  }

  if (legal.length === 1) {
    return {
      card: legal[0],
      reasonCode: 'ONLY_LEGAL_CARD',
    };
  }

  const ledSuit =
    trick.couleurDemandee ??
    trick.cartesJouees?.[0]?.carte?.couleur;

  if (!trick.cartesJouees?.length) {
    if (
      isMisereContract(contract) &&
      contract.joueurId === playerId
    ) {
      return {
        card: [...legal].sort(
          (a, b) =>
            a.valeur - b.valeur ||
            SUITS.indexOf(a.couleur) -
              SUITS.indexOf(b.couleur)
        )[0],
        reasonCode: 'LOW_MISERE_LEAD',
      };
    }

    /*
     * Correction de la défense contre une misère.
     *
     * L'ancienne version utilisait :
     *
     * [...candidates].sort((a, b) => b.valeur - a.valeur)[0]
     *
     * Cela sélectionnait systématiquement la carte la plus haute.
     */
    if (
      isMisereContract(contract) &&
      contract.joueurId !== playerId
    ) {
      const card = chooseMisereDefenseLead(
        legal,
        hand,
        contract,
        completedTricks,
        trick
      );

      return {
        card,
        reasonCode: 'PRESSURE_MISERE',
      };
    }

    if (
      ['demande', 'trou', 'trou_royal'].includes(
        contract?.id
      ) &&
      contract.joueurId === playerId
    ) {
      const calledSuit =
        typeof contract.asPartenaire === 'object'
          ? contract.asPartenaire.couleur
          : String(
            contract.asPartenaire ?? ''
          ).match(
            /^\d+[_-](COEUR|CARREAU|TREFLE|PIQUE)$/
          )?.[1];

      const calledCardPlayed = [
        ...completedTricks.flatMap(
          done => done.cartesJouees ?? []
        ),
        ...(trick.cartesJouees ?? []),
      ].some(
        play =>
          calledCardMatches(
            play.carte,
            contract.asPartenaire
          )
      );

      const calledSuitCards = legal.filter(
        card => card.couleur === calledSuit
      );

      if (
        calledSuit &&
        !calledCardPlayed &&
        calledSuitCards.length
      ) {
        return {
          card: [...calledSuitCards].sort(
            (a, b) => a.valeur - b.valeur
          )[0],
          reasonCode: 'CALL_PARTNER',
        };
      }
    }

    const unseenHigher = card =>
      Math.max(
        0,
        14 -
          card.valeur -
          hand.filter(
            own =>
              own.couleur === card.couleur &&
              own.valeur > card.valeur
          ).length -
          playedCards.filter(
            played =>
              played.couleur === card.couleur &&
              played.valeur > card.valeur
          ).length
      ) +
      (
        contract?.atout &&
        card.couleur !== contract.atout
          ? 13 -
            playedCards.filter(
              played =>
                played.couleur === contract.atout
            ).length -
            hand.filter(
              own =>
                own.couleur === contract.atout
            ).length
          : 0
      );

    const card = [...legal].sort((a, b) =>
      unseenHigher(a) - unseenHigher(b) ||
      (
        a.couleur === contract?.atout
          ? 1
          : 0
      ) -
        (
          b.couleur === contract?.atout
            ? 1
            : 0
        ) ||
      b.valeur - a.valeur
    )[0];

    return {
      card,
      reasonCode:
        card.couleur === contract?.atout
          ? 'BALANCED_PLAY'
          : 'SAFE_OPENING_LEAD',
    };
  }

  const activeTrump =
    contract?.sanAtout ||
    isMisereContract(contract)
      ? null
      : (
        trump ??
        contract?.atout ??
        null
      );

  const currentWinner = winningPlay(
    trick,
    activeTrump
  );

  const partnerId = revealedPartner(
    contract ?? {},
    completedTricks,
    trick,
    hand,
    playerId
  );

  const teammateAhead = teamFor(
    contract,
    partnerId,
    playerId,
    currentWinner.joueurId
  );

  const isMisereSolist =
    isMisereContract(contract) &&
    contract.joueurId === playerId;

  const calledCard =
    contract?.asPartenaire &&
    hand.find(
      card =>
        calledCardMatches(
          card,
          contract.asPartenaire
        )
    );

  const remainingOpponents =
    playersRemainingAfterCurrent(
      playerId,
      trick
    ).some(
      opponentId =>
        !teamFor(
          contract,
          partnerId,
          playerId,
          opponentId
        )
    );

  if (isMisereSolist) {
    const safe = legal.filter(
      card =>
        !beats(
          card,
          currentWinner.carte,
          ledSuit,
          activeTrump
        )
    );

    if (!safe.length) {
      return {
        card: [...legal].sort(
          (a, b) => a.valeur - b.valeur
        )[0],
        reasonCode: 'CANNOT_WIN',
      };
    }

    return {
      card: discardCard(
        safe,
        activeTrump,
        true
      ),
      reasonCode: 'SHED_DANGEROUS_HONOR',
    };
  }

  if (
    isMisereContract(contract) &&
    contract.joueurId !== playerId
  ) {
    if (
      currentWinner.joueurId ===
      contract.joueurId
    ) {
      const winning = legal.filter(
        card =>
          beats(
            card,
            currentWinner.carte,
            ledSuit,
            activeTrump
          )
      );

      if (winning.length) {
        return {
          card: [...winning].sort(
            (a, b) => a.valeur - b.valeur
          )[0],
          reasonCode: 'FORCE_MISERE_WIN',
        };
      }
    }

    return {
      card: discardCard(
        legal,
        activeTrump
      ),
      reasonCode: 'PRESSURE_MISERE',
    };
  }

  if (
    teammateAhead &&
    calledCard &&
    partnerId === playerId &&
 ainingOpponents
  ) {
    return {
      card: calledCard,
      reasonCode: 'REVEAL_PARTNER',
    };
  }

  if (teammateAhead) {
    return {
      card: discardCard(
        legal,
        activeTrump
      ),
      reasonCode: 'PARTNER_WINNING',
    };
  }

  const winning = legal.filter(
    card =>
      beats(
        card,
        currentWinner.carte,
        ledSuit,
        activeTrump
      )
  );

  if (winning.length) {
    return {
      card: [...winning].sort(
        (a, b) => a.valeur - b.valeur
      )[0],
      reasonCode: 'CHEAPEST_WINNER',
    };
  }

  const safeDiscards = legal.filter(
    card =>
      card.valeur !== 14 ||
      card.couleur === activeTrump
  );

  return {
    card: discardCard(
      safeDiscards.length
        ? safeDiscards
        : legal,
      activeTrump
    ),
    reasonCode:
      safeDiscards.length
        ? 'SAFE_DISCARD'
        : 'CANNOT_WIN',
  };
}

function evaluateCandidate({
  card,
  preferredCard,
  reasonCode,
  hand,
  playerId,
  trick,
  activeTrump,
  contract,
  currentWinner,
  teammateAhead,
  visible,
  completedTricks,
  options,
}) {
  const ledSuit =
    trick?.couleurDemandee ??
    trick?.cartesJouees?.[0]?.carte?.couleur;

  const isLead =
    !trick?.cartesJouees?.length;

  const winsNow =
    !!currentWinner &&
    beats(
      card,
      currentWinner.carte,
      ledSuit,
      activeTrump
    );

  const unseenHigher = countUnseenHigher(
    card,
    hand,
    visible
  );

  const suitLength = hand.filter(
    candidate =>
      candidate.couleur === card.couleur
  ).length;

  const isTrump =
    !!activeTrump &&
    card.couleur === activeTrump;

  const isPreferred = sameCard(
    card,
    preferredCard
  );

  const misere =
    isMisereContract(contract);

  const misereSolist =
    misere &&
    contract?.joueurId === playerId;

  const misereDefender =
    misere &&
    contract?.joueurId !== playerId;

  let score = 50;

  if (isPreferred) {
    score +=
      options.level === 'expert'
        ? 22
        : 18;
  }

  /*
   * La stratégie générique d'entame n'est pas appliquée aux
   * défenseurs d'une misère. Elle favorisait les cartes maîtresses
   * et provoquait les entames hautes observées dans les simulations.
   */
  if (
    isLead &&
    !misereDefender
  ) {
    score += Math.max(
      -8,
      11 - unseenHigher * 3
    );

    if (unseenHigher === 0) {
      score += 9;
    }

    if (isTrump) {
      score -=
        options.personality === 'aggressive'
          ? 1
          : 6;
    }

    if (suitLength >= 4) {
      score += 3;
    }
  }

  if (currentWinner) {
    if (teammateAhead) {
      score -=
        Math.max(
          0,
          card.valeur - 8
        ) * 1.3;

      if (isTrump) {
        score -= 8;
      }

      if (card.valeur === 14) {
        score -= 12;
      }
    } else if (winsNow) {
      score += 24;

      score -=
        Math.max(
          0,
          card.valeur -
            currentWinner.carte.valeur
        ) * 0.45;
    } else {
      score -=
        Math.max(
          0,
          card.valeur - 9
        ) * 0.7;
    }
  }

  if (misereSolist) {
    if (
      currentWinner &&
      winsNow
    ) {
      score -= 42;
    } else {
      score +=
        Math.max(
          0,
          card.valeur - 7
        ) * 1.4;
    }

    if (isHonor(card)) {
      score += 6;
    }
  } else if (misereDefender) {
    if (isLead) {
      /*
       * Évaluation dédiée de l'entame contre une misère.
       */
      score += evaluateMisereDefenseLead(
        card,
        hand,
        contract,
        completedTricks,
        trick
      );
    } else if (
      currentWinner?.joueurId ===
        contract?.joueurId &&
      winsNow
    ) {
      /*
       * Si le déclarant gagne actuellement le pli, le défenseur
       * reprend avec la plus petite carte suffisante.
       */
      score += 30;

      score -=
        Math.max(
          0,
          card.valeur -
            currentWinner.carte.valeur
        ) * 0.8;
    } else if (
      teammateAhead
    ) {
      /*
       * Ne pas gaspiller un honneur lorsque l'un des autres
       * défenseurs maîtrise déjà le pli.
       */
      score -=
        Math.max(
          0,
          card.valeur - 8
        ) * 1.8;
    }
  }

  /*
   * Les ajustements de personnalité ne doivent pas annuler la
   * stratégie spécifique de défense contre une misère.
   */
  if (
    options.personality === 'conservative' &&
    !misereSolist &&
    !misereDefender
  ) {
    if (
      isHonor(card) &&
      !winsNow
    ) {
      score -= 7;
    }

    if (
      isTrump &&
      !winsNow
    ) {
      score -= 6;
    }

    if (winsNow) {
      score += 2;
    }
  }

  if (
    options.personality === 'aggressive' &&
    !misereSolist &&
    !misereDefender
  ) {
    if (winsNow) {
      score += 8;
    }

    if (
      isLead &&
      isHonor(card)
    ) {
      score += 4;
    }

    if (
      isLead &&
      isTrump
    ) {
      score += 4;
    }
  }

  if (
    options.personality === 'balanced' &&
    !misereDefender
  ) {
    if (winsNow) {
      score += 3;
    }

    if (
      card.valeur === 14 &&
      !winsNow
    ) {
      score -= 5;
    }
  }

  if (options.level === 'facile') {
    score =
      50 +
      (score - 50) * 0.55;

    score +=
      (
        card.valeur * 7 +
        SUITS.indexOf(
          card.couleur
        ) * 3
      ) % 5 - 2;
  } else if (options.level === 'expert') {
    /*
     * Le bonus générique de carte maîtresse est désactivé pour
     * l'entame défensive d'une misère.
     */
    if (
      unseenHigher === 0 &&
      !(
        misereDefender &&
        isLead
      )
    ) {
      score += 4;
    }

    if (
      card.valeur === 14 &&
      !winsNow &&
      !isLead
    ) {
      score -= 4;
    }

    if (
      isTrump &&
      teammateAhead
    ) {
      score -= 5;
    }

    if (
      misereDefender &&
      isLead &&
      card.valeur >= 12 &&
      suitLength > 1
    ) {
      score -= 5;
    }
  }

  const personalityReason =
    options.personality === 'aggressive'
      ? 'AGGRESSIVE_CONTROL'
      : options.personality === 'conservative'
        ? 'CONSERVATIVE_SAVE'
        : 'BALANCED_PLAY';

  const finalReason =
    isPreferred
      ? reasonCode
      : (
        misereDefender &&
        isLead
          ? 'PRESSURE_MISERE'
          : personalityReason
      );

  return {
    card,
    score:
      Math.round(score * 10) / 10,
    reasonCode: finalReason,
    explanation: contextualExplanation(
      finalReason,
      {
        card,
        ledSuit,
        activeTrump,
        currentWinner,
        unseenHigher,
      }
    ),
  };
}

function compareEvaluations(left, right) {
  return right.score - left.score ||
    left.card.valeur - right.card.valeur ||
    SUITS.indexOf(left.card.couleur) - SUITS.indexOf(right.card.couleur) ||
    cardKey(left.card).localeCompare(cardKey(right.card));
}

function confidenceFor(evaluations) {
  if (!evaluations.length) return 0;
  if (evaluations.length === 1) return 1;
  const gap = evaluations[0].score - evaluations[1].score;
  return Math.max(0.35, Math.min(0.98, 0.55 + gap / 40));
}

export function analyzeWhistCard(
  hand,
  playerId,
  trick,
  trump,
  contract,
  playedCards = [],
  completedTricks = [],
  rawOptions = {}
) {
  const options = normalizePlayOptions(rawOptions);
  const safeHand = Array.isArray(hand) ? hand : [];
  const safeTrick = trick ?? { cartesJouees: [], couleurDemandee: undefined };
  const safePlayedCards = Array.isArray(playedCards) ? playedCards : [];
  const safeCompletedTricks = Array.isArray(completedTricks) ? completedTricks : [];
  const legal = legalWhistCards(safeHand, safeTrick);

  if (!legal.length) {
    return {
      card: undefined,
      legalCards: [],
      score: 0,
      confidence: 0,
      reasonCode: 'NO_LEGAL_CARD',
      explanation: 'Aucune carte légale n’est disponible.',
      alternatives: [],
      level: options.level,
      personality: options.personality,
      deterministic: options.deterministic,
      aiVersion: WHIST_AI_VERSION,
    };
  }

  const preferred = preferredLegacyDecision(
    safeHand, playerId, safeTrick, trump, contract, safePlayedCards, safeCompletedTricks
  );
  const activeTrump = contract?.sanAtout || contract?.id?.includes('misere')
    ? null
    : (trump ?? contract?.atout ?? null);
  const currentWinner = safeTrick.cartesJouees?.length ? winningPlay(safeTrick, activeTrump) : undefined;
  const partnerId = revealedPartner(contract ?? {}, safeCompletedTricks, safeTrick, safeHand, playerId);
  const teammateAhead = currentWinner
    ? teamFor(contract, partnerId, playerId, currentWinner.joueurId)
    : false;
  const visible = visibleCards(safePlayedCards, safeCompletedTricks, safeTrick);

  const evaluations = legal.map(card => evaluateCandidate({
    card,
    preferredCard: preferred.card,
    reasonCode: preferred.reasonCode,
    hand: safeHand,
    playerId,
    trick: safeTrick,
    activeTrump,
    contract,
    currentWinner,
    teammateAhead,
    visible,
    completedTricks: safeCompletedTricks,
    options,
  })).sort(compareEvaluations);

  let selected = evaluations[0];
  if (options.level === 'moyen') {
    selected = evaluations.find(candidate => sameCard(candidate.card, preferred.card)) ?? selected;
  }
  if (options.level === 'facile' && evaluations.length > 1 && evaluations[0].score - evaluations[1].score <= 7) {
    if (options.deterministic) {
      const selector = (safeCompletedTricks.length + safeTrick.cartesJouees.length + playerId) % 3;
      if (selector === 1) selected = evaluations[1];
    } else if (Math.random() < 0.35) {
      selected = evaluations[1];
    }
  }

  const ordered = [selected, ...evaluations.filter(candidate => candidate !== selected)];
  const alternatives = ordered.slice(1, 1 + options.alternativesLimit).map(candidate => ({
    card: candidate.card,
    score: candidate.score,
    scoreDelta: Math.round((selected.score - candidate.score) * 10) / 10,
    reasonCode: candidate.reasonCode,
    explanation: candidate.explanation,
  }));

  return {
    card: selected.card,
    legalCards: legal,
    score: selected.score,
    confidence: confidenceFor(ordered),
    reasonCode: selected.reasonCode,
    explanation: selected.explanation,
    alternatives,
    level: options.level,
    personality: options.personality,
    deterministic: options.deterministic,
    aiVersion: WHIST_AI_VERSION,
  };
}

export function chooseWhistCard(
  hand,
  playerId,
  trick,
  trump,
  contract,
  playedCards = [],
  completedTricks = [],
  options = {}
) {
  return analyzeWhistCard(
    hand,
    playerId,
    trick,
    trump,
    contract,
    playedCards,
    completedTricks,
    options
  ).card;
}
