import type { Carte, ContratJoue, Couleur, Pli } from '../src/engine/types';

export const WHIST_AI_VERSION: string;
export type WhistCard = Carte;

export interface WhistBidContract {
  id: string;
  priorite?: number;
  prio?: number;
  joueurId?: number;
  partenaireId?: number;
  atout?: Couleur;
  sanAtout?: boolean;
  seul?: boolean;
  asPartenaire?: Carte | string;
  disponibleSi?: (hand: Carte[], currentBid?: ContratJoue | null, playerId?: number) => boolean;
}

export type WhistTrick = Pli;

export function chooseWhistBid(
  hand: WhistCard[],
  currentBid: WhistBidContract | null,
  level: 'facile' | 'moyen' | 'expert',
  playerId: number,
  contracts: WhistBidContract[],
): { action: 'passe' | 'enchere'; contratId?: string; atout?: Couleur; asPartenaire?: string };

export function chooseMisereDiscard(hand: WhistCard[]): WhistCard | undefined;

export function chooseWhistCard(
  hand: WhistCard[],
  playerId: number,
  trick: WhistTrick,
  trump: string | null,
  contract: WhistBidContract | null,
  playedCards?: WhistCard[],
  completedTricks?: WhistTrick[],
): WhistCard | undefined;
