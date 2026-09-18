/**
 * IA Test Runner - Node.js version
 * Exécute 50 parties de Whist de Gand et génère un rapport JSON.
 * Utilise les modules du moteur de jeu.
 */

const { melanger, creerJeu, distribuer } = require('../src/engine/deck');
const { choisirEnchere, choisirCarte } = require('../src/ai/SimpleAI');
const { determinerGagnant, compterPlisParJoueur, estRevélationPartenaire } = require('../src/engine/rules');
const { evaluerReussite } = require('../src/engine/scoring');
const { WhistGand } = require('../src/variants/whistGand');
const fs = require('fs');

async function runSimulation(count = 50) {
    const results = [];
    let successes = 0;

    console.log(`Démarrage de la simulation de ${count} parties...`);

    for (let i = 0; i < count; i++) {
        const jeu = melanger(creerJeu(WhistGand.avecJoker));
        const mains = distribuer(jeu, 4, 0);
        const joueurs = mains.map((m, idx) => ({
            id: idx,
            nom: `IA-${idx}`,
            main: [...m],
            type: 'ia_expert'
        }));

        // --- Enchères ---
        let meilleureEnchere = null;
        let passes = 0;
        let tour = 0;
        while (passes < 4) {
            const id = tour % 4;
            const decision = choisirEnchere(joueurs[id].main, WhistGand, meilleureEnchere, 'expert');
            if (decision.action === 'passe') passes++;
            else {
                passes = 0;
                meilleureEnchere = { ...decision, joueurId: id }; // Simplifié pour le stub
            }
            tour++;
            if (tour > 20) break;
        }

        if (!meilleureEnchere) continue;

        // --- Jeu ---
        let tourDeJoueur = 0;
        let plisTermines = [];
        let atout = meilleureEnchere.atout || null;

        for (let p = 0; p < 13; p++) {
            let pli = { numero: p + 1, cartesJouees: [] };
            for (let j = 0; j < 4; j++) {
                const jId = (tourDeJoueur + j) % 4;
                const cartesDejaJouees = plisTermines.flatMap(pt => pt.cartesJouees.map(c => c.carte));
                const carte = choisirCarte(joueurs[jId], pli, atout, meilleureEnchere, cartesDejaJouees, 'expert');
                pli.cartesJouees.push({ joueurId: jId, carte });
                joueurs[jId].main = joueurs[jId].main.filter(c => c.id !== carte.id);
            }
            const gagnant = determinerGagnant(pli, atout);
            pli.gagnantId = gagnant;
            plisTermines.push(pli);
            tourDeJoueur = gagnant;
        }

        const stats = compterPlisParJoueur(plisTermines);
        const reussite = evaluerReussite(meilleureEnchere, stats);
        if (reussite) successes++;

        results.push({
            id: i + 1,
            contrat: meilleureEnchere.contratId,
            atout: meilleureEnchere.atout,
            reussite
        });
    }

    const report = {
        total: results.length,
        successes,
        rate: (successes / results.length * 100).toFixed(2) + '%',
        details: results
    };

    fs.writeFileSync('./admin/ia-report.json', JSON.stringify(report, null, 2));
    console.log(`Simulation terminée. Rapport généré dans admin/ia-report.json`);
    console.log(`Taux de réussite: ${report.rate}`);
}

// Note: Ce script nécessite que les fichiers source soient compilés ou supportés par Node (require)
// Dans un projet Expo/TS, il est préférable de l'exécuter via ts-node ou jest.
// runSimulation();
