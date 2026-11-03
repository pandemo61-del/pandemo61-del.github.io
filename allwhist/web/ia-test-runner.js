/**
 * IA Test Runner - Node.js version
 *
 * Exécute des parties de Whist de Gand et génère un rapport JSON.
 * Chaque donne contient :
 * - les quatre mains initiales ;
 * - l'historique complet des enchères ;
 * - les plis pour les parties jouées ;
 * - les quatre passes pour une donne sans contrat.
 */

const {
    melanger,
    creerJeu,
    distribuer
} = require('../src/engine/deck');

const {
    choisirEnchere,
    choisirCarte
} = require('../src/ai/SimpleAI');

const {
    determinerGagnant,
    compterPlisParJoueur
} = require('../src/engine/rules');

const {
    evaluerReussite
} = require('../src/engine/scoring');

const {
    WhistGand
} = require('../src/variants/whistGand');

const fs = require('fs');

function clone(value) {
    return JSON.parse(
        JSON.stringify(value)
    );
}

async function runSimulation(count = 50) {
    const results = [];

    let successes = 0;
    let failures = 0;
    let passesGenerales = 0;

    console.log(
        `Démarrage de la simulation de ${count} donnes...`
    );

    for (let i = 0; i < count; i++) {
        const jeu = melanger(
            creerJeu(WhistGand.avecJoker)
        );

        const mains = distribuer(
            jeu,
            4,
            0
        );

        /*
         * Copie des mains avant le jeu.
         */
        const mainsInitiales = clone(mains);

        const joueurs = mains.map(
            (main, index) => ({
                id: index,
                nom: `IA-${index}`,
                main: [...main],
                type: 'ia_expert'
            })
        );

        let meilleureEnchere = null;
        let passes = 0;
        let tour = 0;

        const historiqueEncheres = [];

        while (passes < 4 && tour <= 20) {
            const joueurId = tour % 4;

            const decision = choisirEnchere(
                joueurs[joueurId].main,
                WhistGand,
                meilleureEnchere,
                'expert'
            );

            const enchereHistorique = {
                tour: tour + 1,
                joueurId,
                action: decision.action,
                decision: clone(decision)
            };

            if (decision.action === 'passe') {
                passes++;
            } else {
                passes = 0;

                meilleureEnchere = {
                    ...decision,
                    joueurId
                };

                enchereHistorique.meilleureEnchereApresDecision =
                    clone(meilleureEnchere);
            }

            historiqueEncheres.push(
                enchereHistorique
            );

            tour++;
        }

        /*
         * Les quatre joueurs ont passé.
         *
         * La donne est ajoutée au rapport au lieu d'être ignorée.
         */
        if (!meilleureEnchere) {
            passesGenerales++;

            results.push({
                id: i + 1,
                createdAt:
                    new Date().toISOString(),

                isPasse: true,

                mainsInitiales:
                    clone(mainsInitiales),

                historiqueEncheres:
                    clone(historiqueEncheres),

                contrat: {
                    id: 'passe',
                    contratId: 'passe',
                    nom: 'Tous passent',
                    joueurId: null,
                    partenaireId: null,
                    plisObjectif: null
                },

                atout: null,
                plis: [],

                resultat: {
                    reussite: null,
                    plisFaits: null,
                    deltaScores: {
                        0: 0,
                        1: 0,
                        2: 0,
                        3: 0
                    }
                }
            });

            continue;
        }

        let tourDeJoueur = 0;
        const plisTermines = [];

        const atout =
            meilleureEnchere.atout || null;

        for (let numeroPli = 0;
            numeroPli < 13;
            numeroPli++
        ) {
            const pli = {
                numero: numeroPli + 1,
                cartesJouees: []
            };

            for (let position = 0;
                position < 4;
                position++
            ) {
                const joueurId =
                    (
                        tourDeJoueur +
                        position
                    ) % 4;

                const cartesDejaJouees =
                    plisTermines.flatMap(
                        previousTrick =>
                            previousTrick
                                .cartesJouees
                                .map(
                                    played =>
                                        played.carte
                                )
                    );

                const carte = choisirCarte(
                    joueurs[joueurId],
                    pli,
                    atout,
                    meilleureEnchere,
                    cartesDejaJouees,
                    'expert'
                );

                pli.cartesJouees.push({
                    joueurId,
                    carte
                });

                joueurs[joueurId].main =
                    joueurs[joueurId].main.filter(
                        currentCard =>
                            currentCard.id !==
                            carte.id
                    );
            }

            const gagnant =
                determinerGagnant(
                    pli,
                    atout
                );

            pli.gagnantId = gagnant;

            plisTermines.push(pli);

            tourDeJoueur = gagnant;
        }

        const statistiquesPlis =
            compterPlisParJoueur(
                plisTermines
            );

        const reussite =
            evaluerReussite(
                meilleureEnchere,
                statistiquesPlis
            );

        if (reussite) {
            successes++;
        } else {
            failures++;
        }

        results.push({
            id: i + 1,
            createdAt:
                new Date().toISOString(),

            isPasse: false,

            mainsInitiales:
                clone(mainsInitiales),

            historiqueEncheres:
                clone(historiqueEncheres),

            contrat:
                clone(meilleureEnchere),

            atout,
            plis:
                clone(plisTermines),

            statistiquesPlis:
                clone(statistiquesPlis),

            resultat: {
                reussite
            }
        });
    }

    const partiesJouees =
        results.filter(
            result => !result.isPasse
        );

    const rate =
        partiesJouees.length > 0
            ? (
                successes /
                partiesJouees.length *
                100
            ).toFixed(2) + '%'
            : '0.00%';

    const report = {
        generatedAt:
            new Date().toISOString(),

        totalDonnes:
            results.length,

        partiesJouees:
            partiesJouees.length,

        passesGenerales,

        successes,
        failures,
        rate,

        details: results
    };

    fs.writeFileSync(
        './web/ia-report.json',
        JSON.stringify(
            report,
            null,
            2
        )
    );

    console.log(
        'Simulation terminée. Rapport généré dans web/ia-report.json'
    );

    console.log(
        `Taux de réussite: ${report.rate}`
    );

    console.log(
        `Donnes avec quatre passes: ${passesGenerales}`
    );

    return report;
}

module.exports = {
    runSimulation
};

if (require.main === module) {
    runSimulation(50).catch(error => {
        console.error(
            'Erreur pendant la simulation:',
            error
        );

        process.exitCode = 1;
    });
}
