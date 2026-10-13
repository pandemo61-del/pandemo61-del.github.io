const SUITS = ['COEUR', 'CARREAU', 'TREFLE', 'PIQUE'];
const HONOR_RISK = { 14: 12, 13: 7, 12: 4, 11: 2.5, 10: 1, 9: 0.5 };

export const WHIST_AI_VERSION = '1.1.0';

function contractPriority(contract) {
  return contract?.priorite ?? contract?.prio ?? -1;
}

function estimateTricks(hand, trump) {
  if (trump && hand.length && hand.every(card => card.couleur === trump)) return hand.length;

  const bySuit = Object.fromEntries(SUITS.map(suit => [suit, []]));
  for (const card of hand) {
    if (bySuit[card.couleur]) bySuit[card.couleur].push(card.valeur);
  }

  let estimate = 0;
  for (const [suit, values] of Object.entries(bySuit)) {
    values.sort((a, b) => b - a);
    const length = values.length;
    if (values.includes(14)) estimate += 0.98;
    if (values.includes(13)) estimate += length >= 2 ? 0.72 : 0.38;
    if (values.includes(12)) estimate += length >= 3 ? 0.48 : 0.18;
    if (values.includes(11)) estimate += length >= 4 ? 0.3 : 0.08;
    if (values.includes(10)) estimate += length >= 5 ? 0.18 : 0.04;
    estimate += Math.max(0, length - 4) * (suit === trump ? 0.7 : 0.2);
  }
  return estimate;
}

function misereRisk(hand) {
  return hand.reduce((risk, card) => risk + (HONOR_RISK[card.valeur] ?? 0), 0);
}

export function chooseMisereDiscard(hand) {
  return [...hand].sort((a, b) =>
    (HONOR_RISK[b.valeur] ?? 0) - (HONOR_RISK[a.valeur] ?? 0) ||
    b.valeur - a.valeur
  )[0];
}

function bestTrump(hand) {
  return SUITS
    .map(suit => ({ suit, estimate: estimateTricks(hand, suit), length: hand.filter(card => card.couleur === suit).length }))
    .sort((a, b) => b.estimate - a.estimate || b.length - a.length)[0];
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

export function chooseWhistBid(hand, currentBid, level, playerId, contracts) {
  const currentPriority = contractPriority(currentBid);
  const aces = hand.filter(card => card.valeur === 14);

  if (aces.length === 3 && currentPriority < 7) {
    const calledSuit = SUITS.find(suit => !aces.some(card => card.couleur === suit));
    const contract = availableContract(contracts, 'trou', hand, currentBid, playerId);
    if (contract && contractPriority(contract) > currentPriority) {
      return decisionFor(contract, calledSuit, calledSuit ? `14_${calledSuit}` : undefined);
    }
  }

  if (aces.length === 4 && currentPriority < 7.5) {
    const contract = availableContract(contracts, 'trou_royal', hand, currentBid, playerId);
    if (contract && contractPriority(contract) > currentPriority) {
      return decisionFor(contract, 'COEUR', '13_COEUR');
    }
  }

  const best = bestTrump(hand);
  const strength = best.estimate;
  const thresholds = {
    facile: { solo6: 6.5, solo7: 7.5, solo8: 8.6, abundance9: 9.7, abundance10: 10.7, abundance11: 11.6, abundance12: 12.4, chelem: 13 },
    moyen: { solo6: 6.1, solo7: 7.1, solo8: 8.2, abundance9: 9.3, abundance10: 10.3, abundance11: 11.2, abundance12: 12.1, chelem: 12.8 },
    expert: { solo6: 5.8, solo7: 6.8, solo8: 7.9, abundance9: 9, abundance10: 10, abundance11: 11, abundance12: 12, chelem: 12.7 },
  }[level] ?? { solo6: 5.8, solo7: 6.8, solo8: 7.9, abundance9: 9, abundance10: 10, abundance11: 11, abundance12: 12, chelem: 12.7 };
  const soloContracts = [
    ['chelem', thresholds.chelem],
    ['abondance_12', thresholds.abundance12],
    ['abondance_11', thresholds.abundance11],
    ['abondance_10', thresholds.abundance10],
    ['abondance_9', thresholds.abundance9],
    ['solo_8', thresholds.solo8],
    ['solo_7', thresholds.solo7],
    ['solo_6', thresholds.solo6],
  ];

  for (const [id, target] of soloContracts) {
    const contract = availableContract(contracts, id, hand, currentBid, playerId);
    if (contract && contractPriority(contract) > currentPriority && strength >= target) {
      return decisionFor(contract, best.suit);
    }
  }

  const rawMisereRisk = misereRisk(hand);
  const discardRisk = hand.length
    ? Math.min(...hand.map(card => rawMisereRisk - (HONOR_RISK[card.valeur] ?? 0)))
    : rawMisereRisk;
  const misereCandidates = [
    rawMisereRisk <= 0.05 ? 'misere_ouverte' : null,
    rawMisereRisk <= 1.5 ? 'misere' : null,
    discardRisk <= 3.5 ? 'petite_misere' : null,
  ].filter(Boolean);
  for (const id of misereCandidates) {
    const contract = availableContract(contracts, id, hand, currentBid, playerId);
    if (contract && contractPriority(contract) > currentPriority) {
      return decisionFor(contract, null);
    }
  }

  if (currentBid?.id === 'propose' && currentBid.joueurId !== playerId) {
    const trump = currentBid.atout;
    const suitCards = hand.filter(card => card.couleur === trump);
    const topHonors = suitCards.filter(card => card.valeur >= 13).length;
    const supported = suitCards.length >= 6 ||
      (suitCards.length >= 3 && topHonors >= 2);
    const contract = availableContract(contracts, 'emballe', hand, currentBid, playerId);
    if (supported && contract && contractPriority(contract) > currentPriority) {
      return decisionFor(contract, trump);
    }
  }

  const proposal = availableContract(contracts, 'propose', hand, currentBid, playerId);
  const teamEstimate = strength + 3.5;
  if (
    proposal &&
    contractPriority(proposal) > currentPriority &&
    best.length >= 4 &&
    teamEstimate >= 8.3
  ) {
    return decisionFor(proposal, best.suit);
  }

  return { action: 'passe' };
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
