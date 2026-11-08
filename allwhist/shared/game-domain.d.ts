import type { Carte, Couleur, ContratJoue, Pli } from '../src/engine/types';

export function cartesJouables(main: Carte[], pli: Pli | Array<{ joueurId: number; carte: Carte }>, atout?: Couleur | null): Carte[];
export function estPlusForte(challenger: Carte, actuelle: Carte, couleurDemandee: Couleur, atout?: Couleur | null, ordreInverse?: boolean): boolean;
export function determinerGagnant(pli: Pli | Array<{ joueurId: number; carte: Carte }>, atout?: Couleur | null, ordreInverse?: boolean): number;
export function misereEchouee(plisTermines: Pli[], joueurId: number): boolean;
export function estRevelationPartenaire(carte: Carte, contrat: ContratJoue): boolean;
export function compterPlisParJoueur(plisTermines: Pli[], nbJoueurs?: number): Record<number, number>;
export function mancheTerminee(plisTermines: Pli[], contrat?: ContratJoue): boolean;
export function calculerReussiteWhist(contrat: ContratJoue, plisParJoueur: Record<number, number>): boolean;
export function calculerScoreWhistGand(contrat: ContratJoue, plisParJoueur: Record<number, number>): {
  reussite: boolean;
  plisJoueurEtPartenaire: number;
  deltaScores: Record<number, number>;
  details: string;
  bidderId: number;
  partnerId: number;
  objective: number;
  points: number;
  teamTricks: number;
  defenseIds: number[];
};
