const SUITS = ['COEUR', 'CARREAU', 'TREFLE', 'PIQUE'];
const HONOR_RISK = { 14: 12, 13: 7, 12: 4, 11: 2.5, 10: 1, 9: 0.5 };

export const WHIST_AI_VERSION = '1.2.0';

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
  const lengthBonus = [0, 0, 0, 0, 0.2, 0.65, 1.2, 1.9][trumps.length] ?? 2.6;
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

  // Les coupes ne valent pleinement que si la main possède assez d'atouts.
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
  return surplus * 3 + reward - Math.max(0, -surplus) * 5;
}

export function chooseWhistBid(hand, currentBid, level, playerId, contracts) {
  const currentPriority = contractPriority(currentBid);
  const margin = difficultyMargin(level);
  const aces = hand.filter(card => card.valeur === 14);

  // Les contrats déterministes les plus spécifiques sont testés d'abord.
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

  // Une réponse à Propose est évaluée avant une nouvelle enchère autonome.
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
  const misereOptions = [
    ['petite_misere', discardRisk, 8.5, 2.0],
    ['misere', rawRisk, 5.5, 3.0],
    ['misere_ouverte', rawRisk, 0.75, 5.0],
  ];
  for (const [id, risk, maxRisk, reward] of misereOptions) {
    const contract = availableContract(contracts, id, hand, currentBid, playerId);
    if (!contract || contractPriority(contract) <= currentPriority) continue;
    const utility = (maxRisk - risk) * 0.8 + reward - margin * 2;
    if (risk <= maxRisk && utility > 0) candidates.push({ contract, trump: null, utility });
  }

  const proposal = availableContract(contracts, 'propose', hand, currentBid, playerId);
  if (proposal && contractPriority(proposal) > currentPriority && best.length >= 4) {
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

export function chooseWhistCard(hand, playerId, trick, trump, contract, playedCards = [], completedTricks = []) {
  if (!hand.length) return undefined;
  const ledSuit = trick.couleurDemandee ?? trick.cartesJouees?.[0]?.carte?.couleur;
  const following = !!ledSuit;
  const suited = following ? hand.filter(card => card.couleur === ledSuit) : hand;
  const legal = suited.length ? suited : hand;
  if (!trick.cartesJouees?.length) {
    if (contract?.id?.includes('misere') && contract.joueurId === playerId) {
      return [...legal].sort((a, b) => a.valeur - b.valeur)[0];
    }
    if (contract?.id?.includes('misere')) {
      const exhausted = exhaustedSuits(contract.joueurId, completedTricks, trick);
      const unexhausted = legal.filter(card => !exhausted.has(card.couleur));
      const candidates = unexhausted.length ? unexhausted : legal;
      return [...candidates].sort((a, b) => b.valeur - a.valeur)[0];
    }
    if (['demande', 'trou', 'trou_royal'].includes(contract?.id) && contract.joueurId === playerId) {
      const calledSuit = typeof contract.asPartenaire === 'object'
        ? contract.asPartenaire.couleur
        : String(contract.asPartenaire ?? '').match(/^\d+[_-](COEUR|CARREAU|TREFLE|PIQUE)$/)?.[1];
      const calledCardPlayed = [
        ...completedTricks.flatMap(done => done.cartesJouees ?? []),
        ...(trick.cartesJouees ?? []),
      ].some(play => calledCardMatches(play.carte, contract.asPartenaire));
      const calledSuitCards = legal.filter(card => card.couleur === calledSuit);
      if (calledSuit && !calledCardPlayed && calledSuitCards.length) {
        return [...calledSuitCards].sort((a, b) => a.valeur - b.valeur)[0];
      }
    }
    const unseenHigher = card =>
      Math.max(0, 14 - card.valeur -
        hand.filter(own => own.couleur === card.couleur && own.valeur > card.valeur).length -
        playedCards.filter(played => played.couleur === card.couleur && played.valeur > card.valeur).length) +
      (contract?.atout && card.couleur !== contract.atout
        ? 13 - playedCards.filter(played => played.couleur === contract.atout).length -
          hand.filter(own => own.couleur === contract.atout).length
        : 0);
    return [...legal].sort((a, b) =>
      unseenHigher(a) - unseenHigher(b) ||
      (a.couleur === contract?.atout ? 1 : 0) - (b.couleur === contract?.atout ? 1 : 0) ||
      b.valeur - a.valeur
    )[0];
  }

  const activeTrump = contract?.sanAtout || contract?.id?.includes('misere') ? null : (trump ?? contract?.atout ?? null);
  const currentWinner = winningPlay(trick, activeTrump);
  const partnerId = revealedPartner(contract ?? {}, completedTricks, trick, hand, playerId);
  const teammateAhead = teamFor(contract, partnerId, playerId, currentWinner.joueurId);
  const isMisereSolist = contract?.id?.includes('misere') && contract.joueurId === playerId;
  const calledCard = contract?.asPartenaire && hand.find(card => calledCardMatches(card, contract.asPartenaire));
  const remainingOpponents = [1, 2, 3]
    .slice(0, 3 - trick.cartesJouees.length)
    .map(offset => (playerId + offset) % 4)
    .some(opponentId => !teamFor(contract, partnerId, playerId, opponentId));

  if (isMisereSolist) {
    const safe = legal.filter(card => !beats(card, currentWinner.carte, ledSuit, activeTrump));
    if (!safe.length) return [...legal].sort((a, b) => a.valeur - b.valeur)[0];
    return discardCard(safe, activeTrump, true);
  }

  if (contract?.id?.includes('misere') && contract.joueurId !== playerId) {
    if (currentWinner.joueurId === contract.joueurId) {
      const winning = legal.filter(card => beats(card, currentWinner.carte, ledSuit, activeTrump));
      if (winning.length) return [...winning].sort((a, b) => a.valeur - b.valeur)[0];
    }
    return discardCard(legal, activeTrump);
  }

  if (teammateAhead && calledCard && partnerId === playerId && remainingOpponents) {
    return calledCard;
  }

  if (teammateAhead) return discardCard(legal, activeTrump);
  const winning = legal.filter(card => beats(card, currentWinner.carte, ledSuit, activeTrump));
  if (winning.length) return [...winning].sort((a, b) => a.valeur - b.valeur)[0];
  const safeDiscards = legal.filter(card => card.valeur !== 14 || card.couleur === activeTrump);
  return discardCard(safeDiscards.length ? safeDiscards : legal, activeTrump);
}
