const WHIST_CONTRACT_NAMES = {
  propose: 'Je propose',
  emballe: "J'emballe",
  demande: "Demande à l'As",
  solo_6: 'Solo 6',
  solo_7: 'Solo 7',
  petite_misere: 'Petite Misère',
  solo_8: 'Solo 8',
  abondance_9: 'Abondance 9',
  trou: 'Trou',
  trou_royal: 'Trou Royal',
  abondance_10: 'Abondance 10',
  misere: 'Grande Misère',
  abondance_11: 'Abondance 11',
  abondance_12: 'Abondance 12',
  misere_ouverte: 'Misère sur Table',
  chelem: 'Chelem',
};

export function getWhistContractName(contract) {
  if (typeof contract?.nom === 'string' && contract.nom.trim()) return contract.nom;
  if (Object.hasOwn(WHIST_CONTRACT_NAMES, contract?.id)) return WHIST_CONTRACT_NAMES[contract.id];
  return contract?.id ?? 'Contrat inconnu';
}
