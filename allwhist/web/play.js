import {
            db, auth, collection, doc, setDoc, onAuthStateChanged, googleProvider, signInWithPopup
        } from './firebase-config.js';
        import { getWhistContractName } from '../shared/whist-contracts.js';
        import { chooseMisereDiscard, chooseWhistBid, chooseWhistCard, WHIST_AI_VERSION } from '../shared/whist-ai.js';
        import { cartesJouables, determinerGagnant, estRevelationPartenaire, calculerScoreWhistGand } from '../shared/game-domain.js';

        const SYM = { 'COEUR': '♥', 'CARREAU': '♦', 'TREFLE': '♣', 'PIQUE': '♠' };
        const COULEUR_CSS = { 'COEUR': 'text-red-600', 'CARREAU': 'text-red-600', 'TREFLE': 'text-slate-900', 'PIQUE': 'text-slate-900' };
        const ASSET_IMG = { 'COEUR': 'assets/coeur.png', 'CARREAU': 'assets/carreau.png', 'TREFLE': 'assets/trefle.png', 'PIQUE': 'assets/pique.png' };

        let currentUser = null;
        let hands = [[], [], [], []];
        let mainsInitiales = [[], [], [], []];
        let pliCourant = [];
        let plisHistory = [];
        let leaderId = 0;
        let plisGagnes = [0, 0, 0, 0];
        let totalScores = [0, 0, 0, 0];
        let contratFinal = null;
        let resolutionPliEnCours = false;
        let currentManche = 0;

        const SAVED_SETTINGS = localStorage.getItem('allwhist_play_settings');
        let settings = SAVED_SETTINGS ? JSON.parse(SAVED_SETTINGS) : { sortMethod: 'suit', sortOrder: 'desc', direction: 'lr', son: true, vibration: true, autoBidding: false, autoPlay: false, aiSpeed: 700, maxGames: 13, playerAvatar: 0 };
        settings.playerAvatar = Number.isInteger(settings.playerAvatar) && settings.playerAvatar >= 0 && settings.playerAvatar < 16 ? settings.playerAvatar : 0;
        settings.playerName = (settings.playerName || '').trim();
        settings.suitOrder = Array.isArray(settings.suitOrder) && settings.suitOrder.length === 4 ? settings.suitOrder : ['COEUR', 'CARREAU', 'TREFLE', 'PIQUE'];

        let donneurId = 3;
        let meilleureEnchere = null;
        let historiqueEncheres = [];
        let tourEnchere = 0;
        let passesConsecutifs = 0;
        let propositionRelancee = false;
        let jeuActif = false;

        // ─── COOKIES & SAUVEGARDE DE L'ÉTAT ACTIF DE LA PARTIE ─────

        function setCookie(name, value, days = 1) {
            const d = new Date();
            d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
            const expires = "expires=" + d.toUTCString();
            document.cookie = name + "=" + encodeURIComponent(value) + ";" + expires + ";path=/;SameSite=Lax";
        }

        function getCookie(name) {
            const cname = name + "=";
            const decodedCookie = decodeURIComponent(document.cookie);
            const ca = decodedCookie.split(';');
            for (let i = 0; i < ca.length; i++) {
                let c = ca[i].trim();
                if (c.indexOf(cname) === 0) return c.substring(cname.length, c.length);
            }
            return "";
        }

        function eraseCookie(name) {
            document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        }

        function saveActiveGameState() {
            if (!hands || !hands[0] || (hands[0].length === 0 && !pliCourant.length && !jeuActif && !meilleureEnchere)) {
                clearActiveGameState();
                return;
            }
            const state = {
                currentManche,
                donneurId,
                leaderId,
                hands,
                mainsInitiales,
                meilleureEnchere,
                contratFinal,
                historiqueEncheres,
                tourEnchere,
                passesConsecutifs,
                propositionRelancee,
                jeuActif,
                pliCourant,
                plisGagnes,
                plisHistory,
                totalScores,
                timestamp: Date.now()
            };
            const jsonStr = JSON.stringify(state);
            try {
                localStorage.setItem('allwhist_active_game_state', jsonStr);
                setCookie('allwhist_active_game_state', jsonStr, 1);
            } catch (e) {
                console.warn('Erreur lors de la sauvegarde de la partie active:', e);
            }
        }

        function clearActiveGameState() {
            try {
                localStorage.removeItem('allwhist_active_game_state');
                eraseCookie('allwhist_active_game_state');
            } catch (e) {}
        }

        function loadActiveGameState() {
            try {
                let jsonStr = localStorage.getItem('allwhist_active_game_state');
                if (!jsonStr) {
                    jsonStr = getCookie('allwhist_active_game_state');
                }
                if (!jsonStr) return false;

                const state = JSON.parse(jsonStr);
                if (!state || !state.hands || !Array.isArray(state.hands) || state.hands.length !== 4) return false;

                // Ne pas charger une partie de plus de 24h
                if (Date.now() - (state.timestamp || 0) > 24 * 60 * 60 * 1000) {
                    clearActiveGameState();
                    return false;
                }

                currentManche = state.currentManche || 1;
                donneurId = state.donneurId ?? 3;
                leaderId = state.leaderId ?? 0;
                hands = state.hands;
                mainsInitiales = state.mainsInitiales || state.hands;
                meilleureEnchere = state.meilleureEnchere || null;
                contratFinal = state.contratFinal || null;
                historiqueEncheres = state.historiqueEncheres || [];
                tourEnchere = state.tourEnchere ?? 0;
                passesConsecutifs = state.passesConsecutifs ?? 0;
                propositionRelancee = state.propositionRelancee ?? false;
                jeuActif = state.jeuActif ?? false;
                pliCourant = state.pliCourant || [];
                plisGagnes = state.plisGagnes || [0, 0, 0, 0];
                plisHistory = state.plisHistory || [];
                totalScores = state.totalScores || [0, 0, 0, 0];

                updateMancheBadge();
                updateDealerBadge();
                updatePlisUI();
                updateTrickProgress();
                sortHand();
                renderHandsUI();
                renderPlayerBidLabels();

                if (contratFinal) {
                    const cb = document.getElementById('contrat-badge');
                    if (cb) {
                        cb.classList.remove('hidden');
                        document.getElementById('contrat-name').innerText = contratFinal.nom || getWhistContractName(contratFinal);
                        const targetObj = BAREME_IWW[contratFinal.id]?.obj ?? 0;
                        const currentTeamPlis = plisGagnes[contratFinal.joueurId] + (contratFinal.partenaireId >= 0 ? plisGagnes[contratFinal.partenaireId] : 0);
                        document.getElementById('contrat-target').innerText = `${currentTeamPlis}/${targetObj}`;
                    }
                    if (contratFinal.atout) {
                        const ab = document.getElementById('atout-badge');
                        if (ab) {
                            ab.classList.remove('hidden');
                            const sym = document.getElementById('atout-symbol');
                            if (sym) sym.innerHTML = SYM[contratFinal.atout] || '';
                        }
                    }
                    for (let pid = 0; pid < 4; pid++) {
                        const isBidder = pid === contratFinal.joueurId;
                        const isPartner = pid === contratFinal.partenaireId;
                        const badge = document.getElementById(`badge-j${pid}`);
                        const teamTag = document.getElementById(`team-j${pid}`);
                        if (badge) {
                            badge.classList.toggle('border-emerald-400', isBidder || isPartner);
                            badge.classList.toggle('border-rose-400', !isBidder && !isPartner);
                        }
                        if (teamTag) {
                            teamTag.classList.remove('hidden');
                            teamTag.innerText = (isBidder || isPartner) ? 'Preneur' : 'Défense';
                        }
                    }
                }

                clearTableUI();
                if (pliCourant && pliCourant.length > 0) {
                    pliCourant.forEach(p => {
                        renderTableCard(p.joueurId, p.carte);
                    });
                }

                showMessage("Partie reprise après rafraîchissement d'écran !");

                if (jeuActif) {
                    const tid = (leaderId + pliCourant.length) % 4;
                    updateTurnIndicator(tid);
                    if (tid !== 0) {
                        playAIUntilHuman();
                    }
                } else {
                    prochainTourEnchere();
                }

                return true;
            } catch (e) {
                console.warn('Erreur lors de la restauration de la partie active:', e);
                clearActiveGameState();
                return false;
            }
        }

        const BAREME_IWW = {
            propose: { pts: 10, prio: 1, obj: 8, seul: false },
            emballe: { pts: 10, prio: 1.5, obj: 8, seul: false },
            demande: { pts: 10, prio: 1.8, obj: 8, seul: false },
            solo_6: { pts: 15, prio: 2, obj: 6, seul: true },
            solo_7: { pts: 20, prio: 3, obj: 7, seul: true },
            petite_misere: { pts: 30, prio: 4, obj: 0, seul: true, sa: true },
            solo_8: { pts: 25, prio: 5, obj: 8, seul: true },
            trou: { pts: 30, prio: 7, obj: 9, seul: false },
            trou_royal: { pts: 60, prio: 7.5, obj: 9, seul: false },
            abondance_9: { pts: 40, prio: 8, obj: 9, seul: true },
            abondance_10: { pts: 50, prio: 9, obj: 10, seul: true },
            abondance_11: { pts: 70, prio: 10, obj: 11, seul: true },
            abondance_12: { pts: 100, prio: 11, obj: 12, seul: true },
            misere: { pts: 60, prio: 12, obj: 0, seul: true, sa: true },
            misere_ouverte: { pts: 120, prio: 13, obj: 0, seul: true, sa: true },
            chelem: { pts: 250, prio: 14, obj: 13, seul: true }
        };
        const WHIST_CONTRACTS = Object.entries(BAREME_IWW).map(([id, contract]) => ({
            id,
            priorite: contract.prio,
            plisMin: contract.obj,
            seul: contract.seul,
            sanAtout: contract.sa === true,
            disponibleSi: (hand, currentBid, playerId) => {
                if (id === 'trou') return hand.filter(card => card.valeur === 14).length === 3;
                if (id === 'trou_royal') return hand.filter(card => card.valeur === 14).length === 4;
                if (id === 'emballe') return currentBid?.id === 'propose' && currentBid.joueurId !== playerId;
                return true;
            },
        }));

        const btnStart = document.getElementById('btn-start');
        const modalEnchere = document.getElementById('modal-enchere');
        const modalAtout = document.getElementById('modal-atout');
        const modalScoreboard = document.getElementById('modal-scoreboard');
        const modalResume = document.getElementById('modal-resume');
        const modalAuctionHistory = document.getElementById('modal-auction-history');
        const PLAYER_LABELS = ['VOUS', 'J2', 'J3', 'J4'];
        const AVATAR_PROFILES = [
            { avatar: 0, gender: 'H', names: ['Thomas', 'Nicolas', 'Julien', 'Laurent', 'Olivier'] },
            { avatar: 1, gender: 'F', names: ['Sophie', 'Julie', 'Claire', 'Émilie', 'Nathalie'] },
            { avatar: 2, gender: 'H', names: ['Marc', 'Philippe', 'David', 'Christophe', 'Patrick'] },
            { avatar: 3, gender: 'F', names: ['Isabelle', 'Caroline', 'Valérie', 'Céline', 'Sandrine'] },
            { avatar: 4, gender: 'H', names: ['Lucas', 'Maxime', 'Antoine', 'Alexandre', 'Jonathan'] },
            { avatar: 5, gender: 'F', names: ['Laura', 'Chloé', 'Camille', 'Manon', 'Pauline'] },
            { avatar: 6, gender: 'H', names: ['Pierre', 'Vincent', 'Sébastien', 'Frédéric', 'Benoît'] },
            { avatar: 7, gender: 'F', names: ['Anne', 'Florence', 'Véronique', 'Catherine', 'Christine'] },
            { avatar: 8, gender: 'F', names: ['Emma', 'Louise', 'Alice', 'Juliette', 'Charlotte'] },
            { avatar: 9, gender: 'H', names: ['Arthur', 'Hugo', 'Louis', 'Victor', 'Gabriel'] },
            { avatar: 10, gender: 'F', names: ['Amélie', 'Audrey', 'Mélanie', 'Aurélie', 'Delphine'] },
            { avatar: 11, gender: 'H', names: ['Jérôme', 'François', 'Xavier', 'Romain', 'Grégory'] },
            { avatar: 12, gender: 'H', names: ['Simon', 'Mathias', 'Adrien', 'Quentin', 'Rémi'] },
            { avatar: 13, gender: 'F', names: ['Sarah', 'Eva', 'Zoé', 'Léa', 'Clara'] },
            { avatar: 14, gender: 'H', names: ['Bruno', 'Daniel', 'Alain', 'Bernard', 'Michel'] },
            { avatar: 15, gender: 'F', names: ['Marie', 'Justine', 'Amandine', 'Hélène', 'Lucie'] }
        ];

        function setAvatarSprite(element, avatarIndex) {
            if (!element) return;
            const column = avatarIndex % 4;
            const row = Math.floor(avatarIndex / 4);
            element.style.setProperty('--avatar-x', `${column * 100 / 3}%`);
            element.style.setProperty('--avatar-y', `${row * 100 / 3}%`);
        }

        function renderPlayerAvatar() {
            setAvatarSprite(document.getElementById('avatar-j0'), settings.playerAvatar);
            PLAYER_LABELS[0] = settings.playerName || AVATAR_PROFILES.find(item => item.avatar === settings.playerAvatar).names[0];
            const playerNameElement = document.getElementById('name-j0'); if (playerNameElement) playerNameElement.textContent = PLAYER_LABELS[0];
            document.querySelectorAll('.avatar-choice').forEach(button => {
                const selected = Number(button.dataset.avatar) === settings.playerAvatar;
                button.classList.toggle('is-selected', selected);
                button.setAttribute('aria-checked', String(selected));
            });
        }

        function renderAvatarPicker() {
            const picker = document.getElementById('player-avatar-picker');
            if (!picker) return;
            picker.innerHTML = AVATAR_PROFILES.map(profile => {
                const column = profile.avatar % 4;
                const row = Math.floor(profile.avatar / 4);
                return `<button type="button" class="avatar-choice" data-avatar="${profile.avatar}" role="radio" title="Avatar ${profile.avatar + 1}" style="--avatar-x:${column * 100 / 3}%;--avatar-y:${row * 100 / 3}%"></button>`;
            }).join('');
            picker.querySelectorAll('.avatar-choice').forEach(button => {
                button.onclick = () => {
                    settings.playerAvatar = Number(button.dataset.avatar);
                    renderPlayerAvatar();
                    pickAIAvatars();
                    saveSettings();
                };
            });
            renderPlayerAvatar();
        }

            function pickAIAvatars() {
                const pool = AVATAR_PROFILES.map(profile => profile.avatar).filter(avatar => avatar !== settings.playerAvatar);
            
                for (let i = pool.length - 1; i > 0; i--) {
                    const randomIndex = Math.floor(Math.random() * (i + 1));
                    [pool[i], pool[randomIndex]] = [pool[randomIndex], pool[i]];
                }
            
                [1, 2, 3].forEach((playerId, index) => {
                    const avatarIndex = pool[index];
                    const profile = AVATAR_PROFILES.find(item => item.avatar === avatarIndex);
                    const name = profile.names[Math.floor(Math.random() * profile.names.length)];
            
                    PLAYER_LABELS[playerId] = name;
            
                    const avatar = document.getElementById(`avatar-j${playerId}`);
                    const nameElement = document.getElementById(`name-j${playerId}`);
            
                    if (avatar) setAvatarSprite(avatar, avatarIndex);
                    if (nameElement) nameElement.textContent = name;
                });
            }
        let auctionHistoryResolver = null;
        let auctionHistoryTimer = null;
        function hideBiddingPanel() {
            modalEnchere.classList.add('hidden');
            modalEnchere.classList.remove('flex');
        }
        function formatAuctionAction(entry) {
            if (!entry) return '—';
            if (entry.actionLabel) return entry.actionLabel;
            if (entry.isBoucheTrou) return 'Bouche-Trou';
            if (entry.isPasseTrou) return 'Passe-trou';
            if (entry.action === 'passe') return 'Passe';
            const c = entry.contrat || {};
            const name = c.nom || (c.id ? getWhistContractName(c) : 'Enchère');
            const suitSymbol = c.atout && SYM[c.atout] ? ` ${SYM[c.atout]}` : '';
            return `${name}${suitSymbol}`;
        }
        function renderLiveAuctionHistory() {
            const box = document.getElementById('auction-live-history');
            if (!box) return;
            box.innerHTML = historiqueEncheres.length ? historiqueEncheres.map((e, i) => `<div><strong>${i + 1}. ${PLAYER_LABELS[e.joueurId]}</strong> : ${formatAuctionAction(e)}</div>`).join('') : '<span class="text-slate-400">Aucune enchère précédente</span>';
            box.scrollTop = box.scrollHeight;
        }
        function renderPlayerBidLabels() {
            for (let pid = 0; pid < 4; pid++) {
                const el = document.getElementById(`bid-j${pid}`);
                if (!el) continue;
                const last = [...historiqueEncheres].reverse().find(e => e.joueurId === pid);
                el.textContent = last ? formatAuctionAction(last) : '—';
                el.classList.toggle('is-pass', last?.action === 'passe');
                el.classList.toggle('is-bid', last?.action === 'enchere');
            }
        }
        function announceAuctionAction(entry) {
            renderLiveAuctionHistory();
            renderPlayerBidLabels();
            showMessage(`${PLAYER_LABELS[entry.joueurId]} : ${formatAuctionAction(entry)}`, Math.max(1200, settings.aiSpeed + 500));
        }
        function closeAuctionHistory() {
            if (auctionHistoryTimer) clearTimeout(auctionHistoryTimer);
            auctionHistoryTimer = null;
            modalAuctionHistory.classList.add('hidden');
            modalAuctionHistory.classList.remove('flex');
            document.querySelectorAll('.trick-progress').forEach(el => { el.classList.remove('is-visible'); el.replaceChildren(); });
            if (auctionHistoryResolver) { const resolve = auctionHistoryResolver; auctionHistoryResolver = null; resolve(); }
        }
        function showAuctionHistory() {
            hideBiddingPanel();
            const historyList = document.getElementById('auction-history-list');
            if (!historyList) return Promise.resolve();
            historyList.innerHTML = '';

            if (historiqueEncheres && historiqueEncheres.length > 0) {
                historiqueEncheres.forEach((e, i) => {
                    const row = document.createElement('div');
                    row.className = `auction-history-row ${e.action === 'passe' ? 'is-pass' : 'is-bid'}`;

                    const player = document.createElement('span');
                    player.className = 'auction-player';
                    player.textContent = `${i + 1}. ${PLAYER_LABELS[e.joueurId] || ('Joueur ' + (e.joueurId + 1))}`;

                    const action = document.createElement('span');
                    action.className = 'auction-action';
                    action.textContent = formatAuctionAction(e);

                    row.append(player, action);
                    historyList.appendChild(row);
                });
            } else {
                historyList.innerHTML = '<div class="text-slate-500 text-center py-6 font-bold">Aucune enchère enregistrée</div>';
            }

            const auto = settings.autoBidding;
            const modeEl = document.getElementById('auction-history-mode');
            if (modeEl) modeEl.innerText = auto ? 'Fermeture automatique' : 'Validation manuelle';

            const okBtn = document.getElementById('btn-auction-history-ok');
            if (okBtn) okBtn.classList.toggle('hidden', auto);

            modalAuctionHistory.classList.remove('hidden');
            modalAuctionHistory.classList.add('flex');

            return new Promise(resolve => {
                auctionHistoryResolver = resolve;
                if (auto) {
                    auctionHistoryTimer = setTimeout(closeAuctionHistory, Math.max(3500, settings.aiSpeed * 3));
                }
            });
        }
        document.getElementById('btn-auction-history-ok').onclick = closeAuctionHistory;

        function hideSummary() {
            modalResume.classList.add('hidden');
            modalResume.classList.remove('flex');
            contratFinal = null;
            document.querySelectorAll('.trick-progress').forEach(el => {
                el.classList.remove('is-visible');
                el.replaceChildren();
            });
            const cBadge = document.getElementById('contrat-badge');
            if (cBadge) cBadge.classList.add('hidden');
            const aBadge = document.getElementById('atout-badge');
            if (aBadge) aBadge.classList.add('hidden');
        }

        document.getElementById('btn-close-summary').onclick = hideSummary;
        document.getElementById('btn-close-summary-secondary').onclick = hideSummary;
        document.getElementById('btn-next-round').onclick = () => {
            hideSummary();
            startNewGame();
        };

        onAuthStateChanged(auth, user => {
            currentUser = user;
            if (user) {
                document.getElementById('auth-status').innerText = `Joueur: ${user.email}`;
                document.getElementById('auth-status').className = 'text-xs font-medium px-3 py-2 rounded-full bg-emerald-100 text-emerald-700 flex items-center';
            }
        });

        btnStart.onclick = () => startNewGame();
        document.getElementById('btn-settings').onclick = () => {
            updateSettingsUI();
            document.getElementById('modal-settings').classList.add('flex');
            document.getElementById('modal-settings').classList.remove('hidden');
        };
        document.getElementById('btn-scoreboard').onclick = () => { renderScoreboard(); modalScoreboard.classList.add('flex'); modalScoreboard.classList.remove('hidden'); };

	window.changeMaxGames = delta => {
	    settings.maxGames = Math.max(1, settings.maxGames + delta);
	    const el = document.getElementById('input-max-games');
	    if (el) el.value = settings.maxGames;
	    saveSettings();
	};
	
	window.setMaxGames = val => {
	    settings.maxGames = Math.max(1, parseInt(val) || 1);
	    const el = document.getElementById('input-max-games');
	    if (el) el.value = settings.maxGames;
	    saveSettings();
	};

        function generateScenarioDeck(scenarioId) {
            const suits = ['COEUR', 'CARREAU', 'TREFLE', 'PIQUE'];
            const all = [];
            suits.forEach(s => { for (let v = 2; v <= 14; v++) all.push({ valeur: v, couleur: s, id: `${v}-${s}` }); });
            const presetJ0 = [];
            if (scenarioId === 'gand-propose') {
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 13 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 11 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 10 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 8 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 13 && c.couleur === 'PIQUE'));
            } else if (scenarioId === 'gand-demande') {
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 13 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 12 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 11 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 10 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'PIQUE'));
            } else if (scenarioId === 'gand-solo' || scenarioId === 'gand-solo-6') {
                for (let v = 8; v <= 14; v++) presetJ0.push(all.find(c => c.valeur === v && c.couleur === 'PIQUE'));
            } else if (scenarioId === 'gand-solo-7') {
                for (let v = 8; v <= 14; v++) presetJ0.push(all.find(c => c.valeur === v && c.couleur === 'PIQUE'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'CARREAU'));
            } else if (scenarioId === 'gand-solo-8') {
                for (let v = 7; v <= 14; v++) presetJ0.push(all.find(c => c.valeur === v && c.couleur === 'PIQUE'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'TREFLE'));
            } else if (scenarioId === 'gand-petite-misere') {
                suits.forEach(s => {
                    presetJ0.push(all.find(c => c.valeur === 2 && c.couleur === s));
                    presetJ0.push(all.find(c => c.valeur === 3 && c.couleur === s));
                });
            } else if (scenarioId === 'gand-abondance' || scenarioId === 'gand-abondance-9') {
                for (let v = 8; v <= 14; v++) presetJ0.push(all.find(c => c.valeur === v && c.couleur === 'TREFLE'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'PIQUE'));
            } else if (scenarioId === 'gand-abondance-10') {
                for (let v = 7; v <= 14; v++) presetJ0.push(all.find(c => c.valeur === v && c.couleur === 'TREFLE'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'PIQUE'));
            } else if (scenarioId === 'gand-trou') {
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'PIQUE'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'CARREAU'));
            } else if (scenarioId === 'gand-trou-royal') {
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'PIQUE'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'CARREAU'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'TREFLE'));
            } else if (scenarioId === 'gand-misere' || scenarioId === 'gand-misere-ouverte') {
                suits.forEach(s => { presetJ0.push(all.find(c => c.valeur === 2 && c.couleur === s)); presetJ0.push(all.find(c => c.valeur === 3 && c.couleur === s)); });
            } else if (scenarioId === 'gand-chelem') {
                for (let v = 6; v <= 14; v++) presetJ0.push(all.find(c => c.valeur === v && c.couleur === 'COEUR'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'PIQUE'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'CARREAU'));
                presetJ0.push(all.find(c => c.valeur === 14 && c.couleur === 'TREFLE'));
                presetJ0.push(all.find(c => c.valeur === 13 && c.couleur === 'PIQUE'));
            }
            const usedIds = new Set(presetJ0.map(c => c.id));
            const remaining = all.filter(c => !usedIds.has(c.id)).sort(() => Math.random() - 0.5);
            const result = [presetJ0, [], [], []];
            let rIdx = 0;
            for (let j = 0; j < 4; j++) {
                while (result[j].length < 13 && rIdx < remaining.length) {
                    result[j].push(remaining[rIdx++]);
                }
            }
            return result;
        }

        function startNewGame(isRedeal = false) {
            if (!isRedeal) {
                pickAIAvatars();
                if (currentManche >= settings.maxGames || currentManche === 0) { currentManche = 1; totalScores = [0, 0, 0, 0]; }
                else { currentManche++; }
            }
            plisHistory = [];
            historiqueEncheres = [];
            renderPlayerBidLabels();
            updateMancheBadge();
            const scenarioId = new URLSearchParams(window.location.search).get('scenario');
            if (scenarioId) {
                hands = generateScenarioDeck(scenarioId);
                donneurId = 3;

                const scenarioMap = {
                    'gand-propose': { id: 'propose', nom: 'Je propose', sa: false, atout: 'COEUR' },
                    'gand-demande': { id: 'demande', nom: 'Demande à l\'As', sa: false, atout: 'COEUR', asPartenaire: { id: 'AS_TREFLE', valeur: 14, couleur: 'TREFLE' } },
                    'gand-solo': { id: 'solo_6', nom: 'Solo 6', sa: false, atout: 'PIQUE' },
                    'gand-solo-6': { id: 'solo_6', nom: 'Solo 6', sa: false, atout: 'PIQUE' },
                    'gand-solo-7': { id: 'solo_7', nom: 'Solo 7', sa: false, atout: 'PIQUE' },
                    'gand-solo-8': { id: 'solo_8', nom: 'Solo 8', sa: false, atout: 'PIQUE' },
                    'gand-petite-misere': { id: 'petite_misere', nom: 'Petite Misère', sa: true, atout: null },
                    'gand-abondance': { id: 'abondance_9', nom: 'Abondance 9', sa: false, atout: 'TREFLE' },
                    'gand-abondance-9': { id: 'abondance_9', nom: 'Abondance 9', sa: false, atout: 'TREFLE' },
                    'gand-abondance-10': { id: 'abondance_10', nom: 'Abondance 10', sa: false, atout: 'TREFLE' },
                    'gand-trou': { id: 'trou', nom: 'Le Trou', sa: false, atout: 'TREFLE', asPartenaire: { id: 'AS_TREFLE', valeur: 14, couleur: 'TREFLE' } },
                    'gand-trou-royal': { id: 'trou_royal', nom: 'Trou Royal', sa: false, atout: 'COEUR', asPartenaire: { id: 'ROI_COEUR', valeur: 13, couleur: 'COEUR' } },
                    'gand-misere': { id: 'misere', nom: 'Grande Misère', sa: true, atout: null },
                    'gand-misere-ouverte': { id: 'misere_ouverte', nom: 'Misère sur Table', sa: true, atout: null },
                    'gand-chelem': { id: 'chelem', nom: 'Chelem', sa: false, atout: 'COEUR' }
                };
                const scInfo = scenarioMap[scenarioId] || scenarioMap['gand-solo-6'];
                meilleureEnchere = {
                    id: scInfo.id,
                    nom: scInfo.nom,
                    atout: scInfo.atout,
                    sa: scInfo.sa,
                    joueurId: 0,
                    partenaireId: (scInfo.id === 'propose' || scInfo.id === 'demande' || scInfo.id === 'trou' || scInfo.id === 'trou_royal') ? 1 : -1,
                    asPartenaire: scInfo.asPartenaire
                };
            } else {
                donneurId = (donneurId + 1) % 4;
                const suits = ['COEUR', 'CARREAU', 'TREFLE', 'PIQUE'];
                const deck = [];
                suits.forEach(s => { for (let v = 2; v <= 14; v++) deck.push({ valeur: v, couleur: s, id: `${v}-${s}` }); });
                deck.sort(() => Math.random() - 0.5);
                hands = [[], [], [], []];
                for (let i = 0; i < 52; i++) hands[i % 4].push(deck[i]);
            }
            mainsInitiales = hands.map(hand => hand.map(card => ({ ...card })));
            updateDealerBadge();

            contratFinal = null;
            plisGagnes = [0, 0, 0, 0];
            pliCourant = [];
            leaderId = 0;
            passesConsecutifs = 0;
            propositionRelancee = false;
            jeuActif = false;
            updatePlisUI(); updateTrickProgress();
            document.getElementById('contrat-badge').classList.add('hidden');
            document.getElementById('atout-badge').classList.add('hidden');
            document.getElementById('pli-winner-banner').classList.add('hidden');
            document.getElementById('current-bid-info').innerText = scenarioId ? `Scénario: ${scenarioId}` : 'Aucune enchère';
            btnStart.innerHTML = scenarioId ? '<i class="fas fa-redo mr-1"></i> Rejouer l\'annonce' : '<i class="fas fa-plus mr-1"></i> Distribuer';
            for (let i = 0; i < 4; i++) {
                document.getElementById(`badge-j${i}`).classList.remove('border-emerald-400', 'border-rose-400', 'border-transparent');
                document.getElementById(`team-j${i}`).classList.add('hidden');
            }
            clearTableUI();
            sortHand();

            if (scenarioId && meilleureEnchere) {
                const actionEnchere = { joueurId: meilleureEnchere.joueurId, action: 'enchere', contrat: { ...meilleureEnchere } };
                historiqueEncheres.push(actionEnchere);
                for (let offset = 1; offset < 4; offset++) historiqueEncheres.push({ joueurId: (meilleureEnchere.joueurId + offset) % 4, action: 'passe' });
                announceAuctionAction(actionEnchere);
                finaliserEnchere();
            } else {
                meilleureEnchere = null;
                tourEnchere = (donneurId + 1) % 4;
                renderHandsUI();
                saveActiveGameState();
                prochainTourEnchere();
            }
        }

        function sortHand() {
            const h = hands[0];
            const mult = settings.sortOrder === 'desc' ? -1 : 1;
            const reverse = settings.direction === 'rl';
            if (settings.sortMethod === 'suit') {
                h.sort((a,b) => a.couleur !== b.couleur ? settings.suitOrder.indexOf(a.couleur) - settings.suitOrder.indexOf(b.couleur) : (a.valeur - b.valeur) * mult);
            } else {
                h.sort((a,b) => a.valeur !== b.valeur ? (a.valeur - b.valeur) * mult : settings.suitOrder.indexOf(a.couleur) - settings.suitOrder.indexOf(b.couleur));
            }
            if (reverse) h.reverse();
        }

        function updateDealerBadge() {
            const badge = document.getElementById('dealer-badge');
            const posElem = document.getElementById(`pos-j${donneurId}`);
            const tapisElem = document.querySelector('.mat');
            if (!badge || !posElem || !tapisElem) return;
            const pos = posElem.getBoundingClientRect();
            const tapis = tapisElem.getBoundingClientRect();
            if (!pos || !tapis || tapis.width === 0) return;
            badge.style.display = 'flex';
            badge.style.left = (pos.left - tapis.left + pos.width / 2 - 16) + 'px';
            badge.style.top = (pos.top - tapis.top + pos.height / 2 - 16) + 'px';
        }

        async function prochainTourEnchere() {
            if (passesConsecutifs >= 3 && meilleureEnchere) {
                if (meilleureEnchere.id === 'propose' && !propositionRelancee) {
                    propositionRelancee = true;
                    passesConsecutifs = 0;
                    tourEnchere = meilleureEnchere.joueurId;
                } else {
                    finaliserEnchere();
                    return;
                }
            }
            if (passesConsecutifs >= 4 && !meilleureEnchere) {
                if (historiqueEncheres.length === 4) {
                    passesConsecutifs = 0;
                    showMessage("Aucun Trou annoncé. Début des enchères ordinaires.");
                    saveActiveGameState();
                    return prochainTourEnchere();
                }
                hideBiddingPanel();
                await showAuctionHistory();
                const sauvegardeReussie = await sauvegarderPasse();
                showMessage(
                    sauvegardeReussie
                        ? "Tout le monde a passé. Donne enregistrée, redistribution..."
                        : "Tout le monde a passé. Sauvegarde impossible, redistribution...",
                    5000,
                );
                setTimeout(() => startNewGame(true), 1200);
                return;
            }
            const id = tourEnchere % 4;
            updateTurnIndicator(id);
            if (id === 0) {
                if (settings.autoBidding) {
                    await new Promise(r => setTimeout(r, settings.aiSpeed));
                    const decision = deciderEnchereIA(hands[0], meilleureEnchere);
                    const currPrio = meilleureEnchere ? BAREME_IWW[meilleureEnchere.id].prio : -1;
                    if (decision && BAREME_IWW[decision.id].prio > currPrio) validerEnchereHumain(decision.id, decision.nom, decision.atout, decision.asPartenaire);
                    else passerEnchereWeb(id);
                } else openBiddingModal();
            } else {
                await new Promise(r => setTimeout(r, settings.aiSpeed));
                const decision = deciderEnchereIA(hands[id], meilleureEnchere);
                if (!decision || (meilleureEnchere && BAREME_IWW[decision.id].prio <= BAREME_IWW[meilleureEnchere.id].prio)) {
                    passerEnchereWeb(id);
                    return;
                }
                else {
                    let pId = (decision.id === 'emballe') ? meilleureEnchere.joueurId : -1;
                    meilleureEnchere = { ...decision, joueurId: id, partenaireId: pId };
                    const actionEnchere = { joueurId: id, action: 'enchere', contrat: { ...meilleureEnchere } };
                    historiqueEncheres.push(actionEnchere);
                    announceAuctionAction(actionEnchere);
                    passesConsecutifs = 0;
                    propositionRelancee = false;
                    const atoutTrou = ['trou', 'trou_royal'].includes(meilleureEnchere.id) && meilleureEnchere.atout ? ` — Atout ${SYM[meilleureEnchere.atout]}` : '';
                    document.getElementById('current-bid-info').innerText = `${meilleureEnchere.nom}${atoutTrou} (J${id+1})`;
                }
                saveActiveGameState();
                tourEnchere++; prochainTourEnchere();
            }
        }

        function passerEnchereWeb(playerId) {
            hideBiddingPanel();
            let isBoucheTrou = false;
            let isPasseTrou = false;
            let actionLabel = 'Passe';

            if (meilleureEnchere && (meilleureEnchere.id === 'trou' || meilleureEnchere.id === 'trou_royal')) {
                const targetMatch = meilleureEnchere.asPartenaire ? String(meilleureEnchere.asPartenaire).match(/^(\d+)[_-](COEUR|CARREAU|TREFLE|PIQUE)$/) : null;
                if (targetMatch && hands[playerId].some(c => c.valeur === Number(targetMatch[1]) && c.couleur === targetMatch[2])) {
                    isBoucheTrou = true;
                    actionLabel = 'Bouche-Trou';
                    meilleureEnchere.partenaireId = playerId;
                }
            } else if (!meilleureEnchere && historiqueEncheres.length < 4) {
                isPasseTrou = true;
                actionLabel = 'Passe-trou';
            }

            const actionPasse = { joueurId: playerId, action: 'passe', isBoucheTrou, isPasseTrou, actionLabel };
            historiqueEncheres.push(actionPasse);
            announceAuctionAction(actionPasse);
            const proposerRefuse = propositionRelancee && meilleureEnchere?.id === 'propose' && meilleureEnchere.joueurId === playerId;
            if (proposerRefuse) {
                meilleureEnchere = null;
                passesConsecutifs = 1;
                propositionRelancee = false;
            } else {
                passesConsecutifs++;
            }
            saveActiveGameState();
            tourEnchere++;
            prochainTourEnchere();
        }

        function deciderEnchereIA(hand, currentBid) {
            const playerId = tourEnchere % 4;
            const decision = chooseWhistBid(
                hand,
                currentBid,
                'expert',
                playerId,
                WHIST_CONTRACTS,
                { premierTourAs: historiqueEncheres.length < 4 },
            );
            if (decision.action === 'passe' || !decision.contratId) return null;
            return {
                ...BAREME_IWW[decision.contratId],
                ...decision,
                id: decision.contratId,
                nom: getWhistContractName({ id: decision.contratId }),
            };
        }

        async function finaliserEnchere() {
            hideBiddingPanel();
            await showAuctionHistory();
            contratFinal = meilleureEnchere; jeuActif = true;
            document.getElementById('turn-indicator').classList.add('hidden');

            const cb = document.getElementById('contrat-badge');
            let label = contratFinal.nom;
            if (contratFinal.id === 'emballe') {
                label = `Propose (J${contratFinal.partenaireId + 1}) & Emballe (J${contratFinal.joueurId + 1})`;
            } else {
                label = `${contratFinal.nom} (J${contratFinal.joueurId + 1})`;
            }
            cb.innerText = label;
            cb.classList.remove('hidden');

            const ab = document.getElementById('atout-badge');
            if (contratFinal.sa) {
                ab.innerHTML = '<span class="text-rose-800 text-[10px] font-black uppercase">Sans Atout</span>';
            } else {
                const atout = contratFinal.atout;
                const atoutColor = (atout === 'COEUR' || atout === 'CARREAU') ? '#dc2626' : '#f7f2e6';
                ab.innerHTML = `<span class="text-rose-800 text-[10px] font-black uppercase">Atout</span><span class="atout-symbol" style="color:${atoutColor}" aria-label="${atout}">${SYM[atout] || ''}</span>`;
            }
            ab.classList.remove('hidden'); ab.classList.add('flex');

            const bidderId = contratFinal.joueurId;
            const hasPartner = (
                (contratFinal.id === 'propose' || contratFinal.id === 'emballe' || contratFinal.id === 'trou' || contratFinal.id === 'trou_royal') &&
                contratFinal.partenaireId !== undefined &&
                contratFinal.partenaireId !== null &&
                contratFinal.partenaireId >= 0 &&
                contratFinal.partenaireId !== bidderId
            );
            const partnerId = hasPartner ? contratFinal.partenaireId : -1;
            const isKnownSolo = !hasPartner && !contratFinal.asPartenaire;
            for (let i = 0; i < 4; i++) {
                const b = document.getElementById(`badge-j${i}`), tl = document.getElementById(`team-j${i}`);
                if (!b || !tl) continue;
                b.classList.remove('border-emerald-400', 'border-rose-400');
                if (i === bidderId || (hasPartner && i === partnerId)) {
                    b.classList.add('border-emerald-400');
                    tl.innerText = isKnownSolo ? 'SOLO' : 'EQUIPE A';
                    tl.className = 'absolute -top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-emerald-600 text-white text-[8px] font-black rounded-full z-10 border border-white/20';
                    tl.classList.remove('hidden');
                } else if (isKnownSolo || hasPartner) {
                    b.classList.add('border-rose-400');
                    tl.innerText = 'EQUIPE B';
                    tl.className = 'absolute -top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-rose-600 text-white text-[8px] font-black rounded-full z-10 border border-white/20';
                    tl.classList.remove('hidden');
                } else {
                    tl.classList.add('hidden');
                }
            }
            if (contratFinal.id === 'petite_misere') {
                hands.forEach(hand => {
                    const discarded = chooseMisereDiscard(hand);
                    if (discarded) hand.splice(hand.findIndex(card => card.id === discarded.id), 1);
                });
                renderHandsUI();
            }
            leaderId = (donneurId + 1) % 4; startTrick();
        }

        function renderHandsUI() {
            const h0 = document.getElementById('hand-j0');
            const tourId = (leaderId + pliCourant.length) % 4;
            const monTour = tourId === 0 && jeuActif;
            h0.innerHTML = hands[0].map(c => {
                const playable = monTour && isCardPlayable(c);
                return `<div class="card-container ${!playable && jeuActif ? 'disabled' : ''}" onclick="window.playHumanCard('${c.id}')"><div class="playing-card ${COULEUR_CSS[c.couleur]}"><div class="card-top"><span class="card-value">${getLabel(c.valeur)}</span><img class="card-suit-img" src="${ASSET_IMG[c.couleur]}" alt="${c.couleur}"></div><div class="card-suit-main"><img src="${ASSET_IMG[c.couleur]}" alt="${c.couleur}"></div><div class="card-bottom"><span class="card-value">${getLabel(c.valeur)}</span><img class="card-suit-img" src="${ASSET_IMG[c.couleur]}" alt="${c.couleur}"></div></div></div>`;
            }).join('');
            document.getElementById('hand-j2').innerHTML = hands[2].map(() => `<div class="w-6 h-10 bg-slate-600 rounded border border-white/20 flex items-center justify-center text-[8px] text-white font-black">${Math.random() > 0.5 ? '♠' : '♥'}</div>`).join('');
        }

        function isCardPlayable(card) {
            return cartesJouables(hands[0], {
                cartesJouees: pliCourant,
                couleurDemandee: pliCourant[0]?.carte.couleur,
            }).some(playable => playable.id === card.id);
        }

		function positionBiddingPanel() {
		    if (!modalEnchere || modalEnchere.classList.contains('hidden')) return;
		
		    const hand = document.getElementById('hand-j0');
		    const panel = modalEnchere.querySelector('.auction-panel-card');
		    if (!hand || !panel) return;
		
		    const handRect = hand.getBoundingClientRect();
		    const panelHeight = panel.offsetHeight;
		    const gap = 12;
		    const margin = 8;
		
		    let top = handRect.top - panelHeight - gap;
		    top = Math.max(margin, top);
		
		    modalEnchere.style.top = `${Math.round(top)}px`;
		}

        function openBiddingModal() {
            const opts = document.getElementById('enchere-options');
            const bids = [
                {id:'propose',nom:'Propose'},
                {id:'emballe',nom:'J\'emballe'},
                {id:'demande',nom:'Demande à l\'As'},
                {id:'solo_6',nom:'Solo 6'},
                {id:'solo_7',nom:'Solo 7'},
                {id:'petite_misere',nom:'Petite Misère'},
                {id:'solo_8',nom:'Solo 8'},
                {id:'abondance_9',nom:'Abondance 9'},
                {id:'trou',nom:'Trou (3 As)'},
                {id:'trou_royal',nom:'Trou Royal (4 As)'},
                {id:'abondance_10',nom:'Abondance 10'},
                {id:'misere',nom:'Grande Misère'},
                {id:'abondance_11',nom:'Abondance 11'},
                {id:'abondance_12',nom:'Abondance 12'},
                {id:'misere_ouverte',nom:'Misère sur Table'},
                {id:'chelem',nom:'Chelem'}
            ];
            const scenarioId = new URLSearchParams(window.location.search).get('scenario');
            const scenarioMap = {
                'gand-propose': 'propose', 'gand-demande': 'demande',
                'gand-solo': 'solo_6', 'gand-solo-6': 'solo_6', 'gand-solo-7': 'solo_7', 'gand-solo-8': 'solo_8',
                'gand-petite-misere': 'petite_misere', 'gand-abondance': 'abondance_9', 'gand-abondance-9': 'abondance_9',
                'gand-abondance-10': 'abondance_10', 'gand-trou': 'trou', 'gand-trou-royal': 'trou_royal',
                'gand-misere': 'misere', 'gand-misere-ouverte': 'misere_ouverte', 'gand-chelem': 'chelem'
            };
            const targetBidId = scenarioId ? scenarioMap[scenarioId] : null;

            const curr = meilleureEnchere ? BAREME_IWW[meilleureEnchere.id].prio : -1;
            const nbAs = hands[0] ? hands[0].filter(c => c.valeur === 14).length : 0;
            const estPremierTourAs = historiqueEncheres.length < 4;
            const isTrouActif = meilleureEnchere && (meilleureEnchere.id === 'trou' || meilleureEnchere.id === 'trou_royal');
            let aLe4emeAs = false;
            if (isTrouActif && meilleureEnchere.asPartenaire) {
                const targetMatch = String(meilleureEnchere.asPartenaire).match(/^(\d+)[_-](COEUR|CARREAU|TREFLE|PIQUE)$/);
                if (targetMatch) {
                    const v = Number(targetMatch[1]), suit = targetMatch[2];
                    aLe4emeAs = hands[0].some(c => c.valeur === v && c.couleur === suit);
                }
            }

            const doitAnnoncerTrou = estPremierTourAs &&
                ((nbAs === 3 && curr < BAREME_IWW.trou.prio) ||
                    (nbAs === 4 && curr < BAREME_IWW.trou_royal.prio));
            const btnPasse = document.getElementById('btn-passe');
            if (btnPasse) {
                btnPasse.disabled = doitAnnoncerTrou;
                if (aLe4emeAs) {
                    btnPasse.textContent = meilleureEnchere?.id === 'trou_royal'
                        ? "Bouche-Trou (Roi de Cœur)"
                        : "Bouche-Trou (4ème As)";
                    btnPasse.className = "auction-pass-button bg-amber-500 hover:bg-amber-600 text-white font-black";
                } else if (estPremierTourAs && !meilleureEnchere) {
                    btnPasse.textContent = doitAnnoncerTrou
                        ? (nbAs === 4 ? "Trou Royal obligatoire" : "Trou obligatoire")
                        : "Passe-trou (Moins de 3 As)";
                    btnPasse.className = "auction-pass-button";
                } else {
                    btnPasse.textContent = "Passer";
                    btnPasse.className = "auction-pass-button";
                }
            }

            opts.innerHTML = bids
                .filter(p => !estPremierTourAs || p.id === 'trou' || p.id === 'trou_royal')
                .map(p => {
                let dis;
                if (estPremierTourAs) {
                    dis = p.id === 'trou'
                        ? nbAs !== 3 || curr >= BAREME_IWW.trou.prio
                        : nbAs !== 4 || curr >= BAREME_IWW.trou_royal.prio;
                } else {
                    dis = BAREME_IWW[p.id].prio < curr;
                    if (p.id === 'propose') dis = meilleureEnchere ? meilleureEnchere.id !== 'propose' : false;
                    if (p.id === 'emballe') dis = !meilleureEnchere || meilleureEnchere.id !== 'propose' || meilleureEnchere.joueurId === 0;
                    if (p.id === 'demande') dis = !meilleureEnchere || meilleureEnchere.id !== 'propose' || meilleureEnchere.joueurId !== 0;
                    if (p.id === 'trou') dis = nbAs !== 3 || curr >= BAREME_IWW['trou'].prio;
                    if (p.id === 'trou_royal') dis = nbAs !== 4 || curr >= BAREME_IWW['trou_royal'].prio;
                }

                const isTarget = targetBidId === p.id;
                const btnClass = isTarget ? 'bg-amber-100 hover:bg-amber-200 text-amber-950 border-amber-400 font-black ring-2 ring-amber-400' : (dis ? 'bg-slate-50 text-slate-300 border-slate-200' : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-200');
                const badge = isTarget ? '<span class="block text-[10px] text-amber-800 uppercase font-black mt-0.5">⭐ Annonce du Scénario</span>' : '';
                return `<button ${dis?'disabled':''} data-bid-id="${p.id}" data-bid-name="${p.nom.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" class="bid-option p-3 ${btnClass} font-bold text-xs rounded-xl border transition flex flex-col items-center justify-center text-center" type="button">${p.nom}${badge}</button>`;
            }).join('');
            opts.querySelectorAll('.bid-option').forEach(button => {
                button.addEventListener('click', () => window.choisirContratWeb(button.dataset.bidId, button.dataset.bidName));
            });
            renderLiveAuctionHistory();
            modalEnchere.classList.add('flex'); modalEnchere.classList.remove('hidden');
			requestAnimationFrame(positionBiddingPanel);
        }
		window.addEventListener('resize', () => {
		    if (!modalEnchere.classList.contains('hidden')) positionBiddingPanel();
		});
        window.choisirContratWeb = (id, nom) => {
            hideBiddingPanel();
            if (id === 'emballe') validerEnchereHumain(id, nom, meilleureEnchere.atout);
            else if (BAREME_IWW[id].sa) validerEnchereHumain(id, nom, null);
            else { window.tmpContrat = { id, nom }; modalAtout.classList.remove('hidden'); modalAtout.classList.add('flex'); }
        };

        window.validerAtoutWeb = (atout) => { modalAtout.classList.add('hidden'); validerEnchereHumain(window.tmpContrat.id, window.tmpContrat.nom, atout); };

        function validerEnchereHumain(id, nom, atout, asPartenaire) {
            if (id === 'trou' && !asPartenaire) {
                const aces = hands[0].filter(card => card.valeur === 14).map(card => card.couleur);
                const couleurAppelee = ['COEUR', 'CARREAU', 'TREFLE', 'PIQUE'].find(suit => !aces.includes(suit));
                asPartenaire = couleurAppelee ? `14_${couleurAppelee}` : undefined;
                atout = couleurAppelee ?? atout;
            }
            if (id === 'trou_royal') {
                asPartenaire ??= '13_COEUR';
                atout = 'COEUR';
            }
            let pId = (id === 'emballe' && meilleureEnchere) ? meilleureEnchere.joueurId : -1;
            meilleureEnchere = { id, nom, atout, asPartenaire, sa: !atout, joueurId: 0, partenaireId: pId };
            const actionEnchere = { joueurId: 0, action: 'enchere', contrat: { ...meilleureEnchere } };
            historiqueEncheres.push(actionEnchere);
            announceAuctionAction(actionEnchere);
            propositionRelancee = false;
            const atoutTrou = ['trou', 'trou_royal'].includes(id) && atout ? ` — Atout ${SYM[atout]}` : '';
            passesConsecutifs = 0; tourEnchere++; document.getElementById('current-bid-info').innerText = `${nom}${atoutTrou} (${PLAYER_LABELS[0]})`;
            saveActiveGameState();
            prochainTourEnchere();
        }

        document.getElementById('btn-passe').onclick = () => { hideBiddingPanel(); passerEnchereWeb(tourEnchere % 4); };

        function choixCarteWeb(playerId) {
            const hand = hands[playerId];
            return chooseWhistCard(
                hand,
                playerId,
                {
                    numero: plisHistory.length + 1,
                    couleurDemandee: pliCourant[0]?.carte.couleur,
                    cartesJouees: pliCourant,
                },
                contratFinal?.atout,
                { ...contratFinal, sanAtout: !!contratFinal?.sa },
                plisHistory.flatMap(trick => trick.cartesJouees.map(play => play.carte)),
                plisHistory,
            );
        }

        function revealWebPartner(playerId, card) {
            if (!contratFinal?.asPartenaire || (Number.isInteger(contratFinal.partenaireId) && contratFinal.partenaireId >= 0)) return;
            if (estRevelationPartenaire(card, contratFinal)) {
                contratFinal.partenaireId = playerId;
                const bidderId = contratFinal.joueurId;
                const isSolo = (playerId === bidderId);
                for (let i = 0; i < 4; i++) {
                    const b = document.getElementById(`badge-j${i}`), tl = document.getElementById(`team-j${i}`);
                    if (!b || !tl) continue;
                    b.classList.remove('border-emerald-400', 'border-rose-400');
                    if (i === bidderId || (!isSolo && i === playerId)) {
                        b.classList.add('border-emerald-400');
                        tl.innerText = isSolo ? 'SOLO' : 'EQUIPE A';
                        tl.className = 'absolute -top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-emerald-600 text-white text-[8px] font-black rounded-full z-10 border border-white/20';
                    } else {
                        b.classList.add('border-rose-400');
                        tl.innerText = 'EQUIPE B';
                        tl.className = 'absolute -top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-rose-600 text-white text-[8px] font-black rounded-full z-10 border border-white/20';
                    }
                    tl.classList.remove('hidden');
                }
                const cardLabel = `${card.valeur === 14 ? 'As' : card.valeur === 13 ? 'Roi' : card.valeur} de ${SYM[card.couleur] || card.couleur}`;
                if (isSolo) {
                    showMessage(`${PLAYER_LABELS[bidderId]} a joué le ${cardLabel} et joue donc seul !`, 3500);
                } else {
                    showMessage(`${PLAYER_LABELS[playerId]} a joué le ${cardLabel} : Partenaire de ${PLAYER_LABELS[bidderId]} !`, 3500);
                }
            }
        }

        function startTrick() {
            resolutionPliEnCours = false;
            pliCourant = [];
            saveActiveGameState();
            if (leaderId !== 0) playAIUntilHuman();
            else {
                updateTurnIndicator(0); renderHandsUI();
                if (settings.autoPlay) setTimeout(() => {
                    const card = choixCarteWeb(0);
                    if (card) window.playHumanCard(card.id);
                }, settings.aiSpeed);
            }
        }

        async function playAIUntilHuman() {
            while (pliCourant.length < 4) {
                if (pliCourant.length === 0) clearTableUI();
                const pid = (leaderId + pliCourant.length) % 4;
                if (pid === 0) {
                    updateTurnIndicator(0); renderHandsUI();
                    if (settings.autoPlay) {
                        await new Promise(r => setTimeout(r, settings.aiSpeed));
                        const card = choixCarteWeb(0);
                        if (card) window.playHumanCard(card.id);
                    }
                    return;
                }
                updateTurnIndicator(pid); await new Promise(r => setTimeout(r, settings.aiSpeed));
                const h = hands[pid];
                const card = choixCarteWeb(pid);
                if (!card) throw new Error(`Aucune carte jouable pour le joueur ${pid}.`);
                revealWebPartner(pid, card);
                h.splice(h.findIndex(held => held.id === card.id), 1);
                pliCourant.push({ joueurId: pid, carte: card }); renderTableCard(pid, card);
                saveActiveGameState();
                if (pliCourant.length === 4) { evaluateTrickEnd(); return; }
            }
        }

        window.playHumanCard = (cardId) => {
            if (!jeuActif) return;
            const idx = hands[0].findIndex(c => c.id === cardId); if (idx === -1) return;
            const tid = (leaderId + pliCourant.length) % 4; if (tid !== 0) return;
            const card = hands[0][idx]; if (!isCardPlayable(card)) return;
            if (pliCourant.length === 0) clearTableUI();
            hands[0].splice(idx, 1); revealWebPartner(0, card); pliCourant.push({ joueurId: 0, carte: card }); renderHandsUI(); renderTableCard(0, card);
            saveActiveGameState();
            if (pliCourant.length === 4) evaluateTrickEnd(); else playAIUntilHuman();
        };

        function renderTableCard(pid, card) {
            const value = getLabel(card.valeur);
            const suit = ASSET_IMG[card.couleur];
            document.getElementById(`table-j${pid}`).innerHTML = `
                <div class="table-card">
                    <div class="card-flipper">
                        <div class="card-face card-face-front playing-card ${COULEUR_CSS[card.couleur]}">
                            <div class="card-top">
                                <span class="card-value">${value}</span>
                                <img class="card-suit-img" src="${suit}" alt="${card.couleur}">
                            </div>
                            <div class="card-suit-main">
                                <img src="${suit}" alt="${card.couleur}">
                            </div>
                            <div class="card-bottom">
                                <span class="card-value">${value}</span>
                                <img class="card-suit-img" src="${suit}" alt="${card.couleur}">
                            </div>
                        </div>
                        <div class="card-face card-face-back">
                            <div class="card-back-inner">
                                <img class="card-back-logo" src="assets/icon.png" alt="AllWhist">
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }
        function updateTurnIndicator(pid) { const ind = document.getElementById('turn-indicator'), t = document.getElementById(`table-j${pid}`); ind.classList.remove('hidden'); ind.style.left = t ? `${t.offsetLeft + 35}px` : '50%'; ind.style.top = t ? `${t.offsetTop + 20}px` : '50%'; }

        async function evaluateTrickEnd() {
            if (resolutionPliEnCours || pliCourant.length !== 4) return;
            resolutionPliEnCours = true;

            // Laisser le navigateur afficher clairement la quatrième carte avant le résultat du pli.
            await new Promise(r => setTimeout(r, 450));

            const at = contratFinal?.sa ? null : contratFinal.atout;
            const bestPlayerId = determinerGagnant(pliCourant, at);
            const best = pliCourant.find(play => play.joueurId === bestPlayerId);
            plisGagnes[best.joueurId]++; leaderId = best.joueurId; updatePlisUI(); updateTrickProgress();
            plisHistory.push({ numero: plisHistory.length + 1, gagnantId: best.joueurId, cartesJouees: pliCourant.map(p => ({ joueurId: p.joueurId, carte: p.carte })) });

            // 1. Mise en évidence de la carte gagnante à sa position exacte
            const winnerFrontCard = document.querySelector(`#table-j${best.joueurId} .card-face-front`) || document.querySelector(`#table-j${best.joueurId} .table-card`);
            if (winnerFrontCard) {
                winnerFrontCard.classList.add('winner-glow');
            }
            await new Promise(r => setTimeout(r, 750));

            if (winnerFrontCard) {
                winnerFrontCard.classList.remove('winner-glow');
            }

            // 2. Regroupement des 4 cartes EN SE RETOURNANT directement SUR la carte gagnante
            const winnerSlot = document.getElementById(`table-j${best.joueurId}`);
            const winnerRect = winnerSlot ? winnerSlot.getBoundingClientRect() : null;
            const offsets = [];

            for (let i = 0; i < 4; i++) {
                const slot = document.getElementById(`table-j${i}`);
                const cardEl = slot ? slot.querySelector('.table-card') : null;
                if (cardEl && slot && winnerRect) {
                    const slotRect = slot.getBoundingClientRect();
                    const jitterX = (Math.random() * 8) - 4;
                    const jitterY = (Math.random() * 8) - 4;
                    const rot = (Math.random() * 12) - 6;

                    const dx = winnerRect.left - slotRect.left + jitterX;
                    const dy = winnerRect.top - slotRect.top + jitterY;

                    offsets[i] = { dx, dy, rot };

                    cardEl.style.zIndex = `${20 + i}`;
                    cardEl.classList.add('is-flipped');
                    cardEl.style.transition = 'transform 0.48s cubic-bezier(0.25, 1, 0.5, 1)';
                    cardEl.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(0.92)`;
                }
            }
            await new Promise(r => setTimeout(r, 520));

            // 3. Envol du tas rassemblé depuis la carte gagnante vers le joueur gagnant
            const flyVector = [
                { x: 0, y: 220 },    // Joueur 0 (Sud) -> vole vers le bas
                { x: -240, y: 0 },   // Joueur 1 (Ouest) -> vole vers la gauche
                { x: 0, y: -220 },   // Joueur 2 (Nord) -> vole vers le haut
                { x: 240, y: 0 }     // Joueur 3 (Est) -> vole vers la droite
            ][best.joueurId];

            for (let i = 0; i < 4; i++) {
                const slot = document.getElementById(`table-j${i}`);
                const cardEl = slot ? slot.querySelector('.table-card') : null;
                if (cardEl && offsets[i]) {
                    const { dx, dy, rot } = offsets[i];
                    const finalX = dx + flyVector.x;
                    const finalY = dy + flyVector.y;

                    cardEl.style.transition = 'transform 0.45s ease-in, opacity 0.45s ease-in';
                    cardEl.style.transform = `translate(${finalX}px, ${finalY}px) rotate(${rot + (best.joueurId % 2 === 0 ? -10 : 10)}deg) scale(0.3)`;
                    cardEl.style.opacity = '0';
                }
            }
            await new Promise(r => setTimeout(r, 480));
            clearTableUI();

            const isMisereContract = contratFinal?.id && String(contratFinal.id).includes('misere');
            const miserePlayerLost = isMisereContract && best.joueurId === contratFinal.joueurId;

            if (hands[0].length === 0 || miserePlayerLost) {
                jeuActif = false;
                const resume = calculerPointsFinaux();
                afficherResumeManche(resume);
                sauvegarderPartie(resume);
                if (currentManche >= settings.maxGames) showMessage('Partie terminée ! Scores finaux affichés.');
                else showMessage(miserePlayerLost ? 'Misère chutée ! La manche est terminée.' : 'Manche terminée ! Résumé ci-dessous.');
                return;
            }

            setTimeout(() => startTrick(), 300);
        }

        function afficherResumeManche(resultat) {
            if (!resultat) {
                console.error('Résumé de manche indisponible.');
                showMessage('Impossible d’afficher le résumé de la manche.', 5000);
                return;
            }
            const data = resultat;
            const scoreEquipeA = data.delta[0] + (data.partnerId >= 0 ? data.delta[data.partnerId] : 0);
            const scoreEquipeB = totalScores.filter((_, index) => index !== 0 && index !== data.partnerId).reduce((a, x) => a + x, 0);
            const contratLabel = contratFinal ? `${contratFinal.nom}${contratFinal.atout ? ` • Atout ${SYM[contratFinal.atout]}` : ''}` : 'Contrat';
            const getPlayerLabel = (id) => {
                const name = PLAYER_LABELS[id];
                if (id === 0) {
                    return (name && name.toUpperCase() !== 'VOUS') ? `${name} (Vous)` : 'Vous';
                }
                const pos = id === 1 ? 'Ouest' : id === 2 ? 'Nord' : 'Est';
                return name ? `${name} (${pos})` : `J${id + 1} (${pos})`;
            };

            const players = [
                { id: 0, label: getPlayerLabel(0), score: totalScores[0] },
                { id: 1, label: getPlayerLabel(1), score: totalScores[1] },
                { id: 2, label: getPlayerLabel(2), score: totalScores[2] },
                { id: 3, label: getPlayerLabel(3), score: totalScores[3] }
            ];

            document.getElementById('resume-content').innerHTML = `
                <div class="rounded-2xl bg-emerald-50 border border-emerald-200 p-4">
                    <div class="text-[10px] font-black uppercase tracking-wider text-emerald-700 mb-2">Contrat</div>
                    <div class="text-xl font-black text-emerald-900">${contratLabel}</div>
                    <div class="mt-3 flex items-center justify-between text-sm">
                        <span class="text-slate-600">Résultat</span>
                        <span class="font-black ${data.reussite ? 'text-emerald-700' : 'text-rose-600'}">${data.reussite ? 'Réussi' : 'Échoué'}</span>
                    </div>
                    <div class="mt-2 flex items-center justify-between text-sm">
                        <span class="text-slate-600">Plis faits</span>
                        <span class="font-black text-slate-800">${data.plisTeam} / ${data.obj}</span>
                    </div>
                    <div class="mt-2 flex items-center justify-between text-sm">
                        <span class="text-slate-600">Équipe</span>
                        <span class="font-black text-slate-800">${data.partnerId >= 0 ? 'Équipe A' : 'Solo'} ${data.reussite ? 'réussie' : 'ratée'}</span>
                    </div>
                </div>
                <div class="space-y-2">
                    ${players.map(player => `
                        <div class="flex items-center justify-between px-3 py-2 rounded-xl ${player.id === 0 ? 'bg-emerald-50 border border-emerald-100' : 'bg-slate-50 border border-slate-100'}">
                            <span class="font-bold text-slate-700">${player.label}</span>
                            <div class="text-right">
                                <span class="font-black ${player.score >= 0 ? 'text-slate-900' : 'text-rose-700'}">${player.score} pts</span>
                                <span class="text-xs ml-1 font-bold ${data.delta[player.id] >= 0 ? 'text-emerald-600' : 'text-rose-600'}">(${data.delta[player.id] >= 0 ? '+' : ''}${data.delta[player.id]})</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;

            document.getElementById('btn-next-round').innerText = currentManche >= settings.maxGames ? 'Nouvelle partie' : 'Nouvelle manche';
            modalResume.classList.add('flex');
            modalResume.classList.remove('hidden');
        }

        function calculerPointsFinaux() {
            const bareme = BAREME_IWW[contratFinal.id];
            const score = calculerScoreWhistGand({
                ...contratFinal,
                obj: bareme.obj,
                pts: bareme.pts,
            }, Object.fromEntries(plisGagnes.map((count, id) => [id, count])));
            const delta = Array.from({ length: 4 }, (_, id) => score.deltaScores[id] ?? 0);
            for (let id = 0; id < 4; id++) totalScores[id] += delta[id];
            updatePlisUI();
            updateTrickProgress();

            return {
                bidderId: score.bidderId,
                partnerId: score.partnerId,
                obj: score.objective,
                pts: score.points,
                plisTeam: score.teamTricks,
                reussite: score.reussite,
                delta,
                defenseIds: score.defenseIds,
                totalScores: totalScores.slice(),
            };
        }

        async function sauvegarderPasse() {
            try {
                const userId = currentUser?.uid || 'ANONYMOUS_WEB';
                const userPseudo = currentUser?.email?.split('@')[0] || 'Invité Web';
                const initialHands = mainsInitiales.map((main, joueurId) => ({
                    joueurId,
                    cartes: main.map(card => ({ ...card })),
                }));
                const gameData = {
                    varianteId: 'whist-gand',
                    manche: currentManche,
                    isWebPlay: true,
                    isPasse: true,
                    sourcePlatform: 'web',
                    aiVersion: WHIST_AI_VERSION,
                    userId,
                    userPseudo,
                    createdAt: new Date().toISOString(),
                    atout: null,
                    contrat: {
                        id: 'passe',
                        nom: 'Passe',
                        joueurId: null,
                        plisObjectif: null,
                    },
                    mainsInitiales: initialHands,
                    donne: initialHands.map(({ joueurId, cartes }) => ({
                        joueurId,
                        nom: PLAYER_LABELS[joueurId] || `Joueur ${joueurId + 1}`,
                        mainInitiale: cartes,
                    })),
                    plis: [],
                    resultat: {
                        reussite: null,
                        plisFaits: null,
                        deltaScores: { 0: 0, 1: 0, 2: 0, 3: 0 },
                    },
                    historiqueEncheres,
                };

                const docId = `WEB_PASS_${Date.now()}_${currentManche}`;
                await setDoc(doc(db, 'games', docId), gameData);
                console.log('Passed Web deal saved successfully!');
                return true;
            } catch (err) {
                console.error('DB Pass Save Error:', err);
                return false;
            }
        }

        function sauvegarderPartie(resultat) {
            try {
                const { bidderId, partnerId, obj, plisTeam, reussite, delta } = resultat;
                const userId = currentUser?.uid || 'ANONYMOUS_WEB';
                const userPseudo = currentUser?.email?.split('@')[0] || 'Invité Web';

                const gameData = {
                    varianteId: 'whist-gand',
                    manche: currentManche,
                    isWebPlay: true,
                    sourcePlatform: 'web',
                    aiVersion: WHIST_AI_VERSION,
                    userId,
                    userPseudo,
                    createdAt: new Date().toISOString(),
                    atout: contratFinal?.atout || null,
                    contrat: {
                        id: contratFinal.id,
                        nom: contratFinal.nom,
                        joueurId: bidderId,
                        plisObjectif: obj,
                        ...(contratFinal.asPartenaire ? { asPartenaire: contratFinal.asPartenaire } : {}),
                        ...(partnerId !== -1 ? { partenaireId: partnerId } : {})
                    },
                    donne: mainsInitiales.map((mainInitiale, joueurId) => ({
                        joueurId,
                        nom: joueurId === 0 ? userPseudo : `IA-${joueurId}`,
                        mainInitiale
                    })),
                    plis: plisHistory,
                    resultat: { reussite, plisFaits: plisTeam, deltaScores: delta },
                    historiqueEncheres,
                };

                const docId = `WEB_PLAY_${Date.now()}`;
                Promise.resolve(setDoc(doc(db, 'games', docId), gameData))
                    .then(() => console.log('Game saved successfully!'))
                    .catch(err => {
                        console.error('DB Save Error:', err);
                        showMessage('Erreur de sauvegarde: ' + err.message, 5000);
                    });
            } catch (err) {
                console.error('DB Save Preparation Error:', err);
                showMessage('Résultats affichés, mais sauvegarde impossible: ' + err.message, 5000);
            }
        }

        function showMessage(msg, dur = 4000) { const bar = document.getElementById('game-message-bar'), txt = document.getElementById('game-message-text'); txt.innerText = msg; bar.classList.remove('hidden'); setTimeout(() => bar.classList.add('hidden'), dur); }
        function saveSettings() { localStorage.setItem('allwhist_play_settings', JSON.stringify(settings)); }
        function updateTrickProgress() {
            document.querySelectorAll('.trick-progress').forEach(el => { el.classList.remove('is-visible'); el.replaceChildren(); });
            if (!contratFinal) return;
            const bidderId = contratFinal.joueurId, partnerId = contratFinal.partenaireId ?? -1, bidTeam = new Set([bidderId, ...(partnerId >= 0 ? [partnerId] : [])]);
            const holder = document.getElementById(`trick-progress-j${bidderId}`);
            if (!holder) return;
            const wonBid = [...bidTeam].reduce((n,id) => n + (plisGagnes[id] || 0), 0), wonDef = plisGagnes.reduce((n,v,id) => n + (bidTeam.has(id) ? 0 : v), 0);
            const bareme = BAREME_IWW[contratFinal.id] || {}, isMisere = /mis[eè]re/i.test(`${contratFinal.id || ''} ${bareme.nom || ''}`), target = isMisere ? 0 : (bareme.obj || contratFinal.target || 0);
            const totalDots = contratFinal.id === 'petite_misere' ? 12 : 13;
            holder.classList.add('is-visible');
            holder.setAttribute('aria-label', isMisere
                ? `${wonDef} plis adversaires (bons), ${wonBid} plis preneur (chute)`
                : `${wonBid} plis équipe enchérissante, ${wonDef} plis défenseurs${target ? `, objectif ${target}` : ''}`);
            for (let i = 0; i < totalDots; i++) {
                const dot = document.createElement('span'); dot.className = 'trick-dot';
                if (isMisere) {
                    // Pour la misère : les plis des adversaires sont bons = vert
                    if (i < wonDef) dot.classList.add('is-bid');
                    // Tout pli pris par le preneur fait chuter = rouge
                    if (i >= totalDots - wonBid) dot.classList.add('is-def');
                } else {
                    if (target > 0 && i === target - 1) dot.classList.add('is-target');
                    if (i < wonBid) dot.classList.add('is-bid');
                    if (i >= totalDots - wonDef) dot.classList.add('is-def');
                }
                holder.appendChild(dot);
            }
        }

        function updatePlisUI() { document.getElementById('plis-j0').innerText = plisGagnes[0]; document.getElementById('score-j0').innerText = totalScores[0]; document.getElementById('plis-j1').innerText = plisGagnes[1]; document.getElementById('score-j1').innerText = totalScores[1]; document.getElementById('plis-j2').innerText = plisGagnes[2]; document.getElementById('score-j2').innerText = totalScores[2]; document.getElementById('plis-j3').innerText = plisGagnes[3]; document.getElementById('score-j3').innerText = totalScores[3]; }
        function updateMancheBadge() { document.getElementById('manche-badge').innerText = `Manche ${currentManche}/${settings.maxGames}`; }
        function clearTableUI() { for (let i = 0; i < 4; i++) document.getElementById(`table-j${i}`).innerHTML = ''; }
        function getLabel(v) { return v === 14 ? 'A' : v === 13 ? 'R' : v === 12 ? 'D' : v === 11 ? 'V' : v; }
        function renderScoreboard() {
            const list = document.getElementById('scoreboard-list');
            const getPlayerScoreLabel = (id) => {
                const name = PLAYER_LABELS[id];
                if (id === 0) return (name && name.toUpperCase() !== 'VOUS') ? `${name} (Vous)` : 'Vous';
                const pos = id === 1 ? 'Ouest' : id === 2 ? 'Nord' : 'Est';
                return name ? `${name} (${pos})` : `${pos} (J${id + 1})`;
            };
            const players = [
                { id: 0, name: getPlayerScoreLabel(0), score: totalScores[0], icon: 'fa-user-tie', color: 'bg-emerald-500' },
                { id: 1, name: getPlayerScoreLabel(1), score: totalScores[1], icon: 'fa-robot', color: 'bg-sky-500' },
                { id: 2, name: getPlayerScoreLabel(2), score: totalScores[2], icon: 'fa-robot', color: 'bg-violet-500' },
                { id: 3, name: getPlayerScoreLabel(3), score: totalScores[3], icon: 'fa-robot', color: 'bg-amber-500' }
            ];
            players.sort((a, b) => b.score - a.score);
            list.innerHTML = players.map((p, idx) => `<div class="flex items-center justify-between p-4 ${p.id === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-100'} border rounded-2xl"><div class="flex items-center gap-3"><div class="w-8 h-8 ${p.color} rounded-full flex items-center justify-center text-white"><i class="fas ${p.icon}"></i></div><div><div class="font-black text-slate-800">${idx + 1}. ${p.name}</div><div class="text-[10px] uppercase text-slate-400">Score total</div></div></div><span class="font-black text-slate-900">${p.score}</span></div>`).join('');
        }
        function renderSuitOrder() {
            const box = document.getElementById('suit-order'); if (!box) return;
            const info = { COEUR:['♥','Cœur'], CARREAU:['♦','Carreau'], TREFLE:['♣','Trèfle'], PIQUE:['♠','Pique'] };
            box.innerHTML = settings.suitOrder.map(suit => `<span class="suit-order-item ${['COEUR','CARREAU'].includes(suit) ? 'suit-red' : ''}" draggable="true" data-suit="${suit}">${info[suit][0]} ${info[suit][1]}</span>`).join(''); let dragged = null;
            box.querySelectorAll('.suit-order-item').forEach(item => { item.ondragstart=()=>{dragged=item.dataset.suit;item.classList.add('dragging');}; item.ondragend=()=>item.classList.remove('dragging'); item.ondragover=e=>e.preventDefault(); item.ondrop=e=>{e.preventDefault();const target=item.dataset.suit;if(!dragged||dragged===target)return;const order=[...settings.suitOrder],from=order.indexOf(dragged),to=order.indexOf(target);order.splice(from,1);order.splice(to,0,dragged);settings.suitOrder=order;sortHand();renderHandsUI();saveSettings();renderSuitOrder();}; });
        }

function updateSettingsUI() {
    const s = settings;
    const nameInput = document.getElementById('player-name-input');

    if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = s.playerName || '';
    }

    // Méthode de tri
    const btnSuit = document.getElementById('set-sort-suit');
    const btnVal = document.getElementById('set-sort-val');
    if (btnSuit) btnSuit.classList.toggle('is-active', s.sortMethod === 'suit');
    if (btnVal) btnVal.classList.toggle('is-active', s.sortMethod === 'value');

    // Ordre des valeurs
    const btnDesc = document.getElementById('set-sort-desc');
    const btnAsc = document.getElementById('set-sort-asc');
    if (btnDesc) btnDesc.classList.toggle('is-active', s.sortOrder === 'desc');
    if (btnAsc) btnAsc.classList.toggle('is-active', s.sortOrder === 'asc');

    // Disposition
    const btnLr = document.getElementById('set-dir-lr');
    const btnRl = document.getElementById('set-dir-rl');
    if (btnLr) btnLr.classList.toggle('is-active', s.direction === 'lr');
    if (btnRl) btnRl.classList.toggle('is-active', s.direction === 'rl');

    // Toggles de Jeu (Son, Vibrations, Enchères auto, Jeu auto)
    const toggles = [
        ['set-son-on', 'set-son-off', s.son],
        ['set-vib-on', 'set-vib-off', s.vibration],
        ['set-auto-bid-on', 'set-auto-bid-off', s.autoBidding],
        ['set-auto-play-on', 'set-auto-play-off', s.autoPlay]
    ];
    toggles.forEach(([onId, offId, active]) => {
        const onEl = document.getElementById(onId);
        const offEl = document.getElementById(offId);
        if (onEl) onEl.classList.toggle('is-active', !!active);
        if (offEl) offEl.classList.toggle('is-active', !active);
    });

    // Vitesse IA
    const speedInput = document.getElementById('set-ai-speed');
    const speedLabel = document.getElementById('ai-speed-label');
    if (speedInput) speedInput.value = s.aiSpeed;
    if (speedLabel) {
        const sec = (s.aiSpeed / 1000).toFixed(1);
        speedLabel.textContent = s.aiSpeed <= 300 ? `Très rapide (${sec}s)` : s.aiSpeed <= 700 ? `Rapide (${sec}s)` : s.aiSpeed <= 1200 ? `Normale (${sec}s)` : `Lente (${sec}s)`;
    }

    renderSuitOrder();
    renderPlayerAvatar();

    const maxGamesInput = document.getElementById('input-max-games');
    if (maxGamesInput) maxGamesInput.value = s.maxGames;
}
        document.getElementById('player-name-input').oninput = event => { settings.playerName = event.target.value.trim().slice(0,20); PLAYER_LABELS[0] = settings.playerName || AVATAR_PROFILES.find(item => item.avatar === settings.playerAvatar).names[0]; const el=document.getElementById('name-j0'); if(el) el.textContent=PLAYER_LABELS[0]; saveSettings(); };
        renderSuitOrder();
        document.getElementById('set-sort-suit').onclick = () => { settings.sortMethod = 'suit'; sortHand(); renderHandsUI(); updateSettingsUI(); saveSettings(); };
        document.getElementById('set-sort-val').onclick = () => { settings.sortMethod = 'value'; sortHand(); renderHandsUI(); updateSettingsUI(); saveSettings(); };
        document.getElementById('set-sort-desc').onclick = () => { settings.sortOrder = 'desc'; sortHand(); renderHandsUI(); updateSettingsUI(); saveSettings(); };
        document.getElementById('set-sort-asc').onclick = () => { settings.sortOrder = 'asc'; sortHand(); renderHandsUI(); updateSettingsUI(); saveSettings(); };
        document.getElementById('set-dir-lr').onclick = () => { settings.direction = 'lr'; sortHand(); renderHandsUI(); updateSettingsUI(); saveSettings(); };
        document.getElementById('set-dir-rl').onclick = () => { settings.direction = 'rl'; sortHand(); renderHandsUI(); updateSettingsUI(); saveSettings(); };
        document.getElementById('set-son-on').onclick = () => { settings.son = true; updateSettingsUI(); saveSettings(); };
        document.getElementById('set-son-off').onclick = () => { settings.son = false; updateSettingsUI(); saveSettings(); };
        document.getElementById('set-vib-on').onclick = () => { settings.vibration = true; updateSettingsUI(); saveSettings(); };
        document.getElementById('set-vib-off').onclick = () => { settings.vibration = false; updateSettingsUI(); saveSettings(); };
        document.getElementById('set-auto-bid-on').onclick = () => {
            settings.autoBidding = true;
            updateSettingsUI();
            saveSettings();
            if (typeof tourEnchere !== 'undefined' && tourEnchere % 4 === 0 && typeof jeuActif !== 'undefined' && !jeuActif) {
                const modalEnchere = document.getElementById('modal-enchere');
                if (modalEnchere) { modalEnchere.classList.add('hidden'); modalEnchere.classList.remove('flex'); }
                prochainTourEnchere();
            }
        };
        document.getElementById('set-auto-bid-off').onclick = () => { settings.autoBidding = false; updateSettingsUI(); saveSettings(); };
        document.getElementById('set-auto-play-on').onclick = () => {
            settings.autoPlay = true;
            updateSettingsUI();
            saveSettings();
            if (typeof tourJeu !== 'undefined' && tourJeu % 4 === 0 && typeof jeuActif !== 'undefined' && jeuActif) {
                choixCarteWeb(0);
            }
        };
        document.getElementById('set-auto-play-off').onclick = () => { settings.autoPlay = false; updateSettingsUI(); saveSettings(); };
        document.getElementById('set-ai-speed').oninput = (e) => { settings.aiSpeed = Number(e.target.value); updateSettingsUI(); saveSettings(); };
        renderAvatarPicker();
        pickAIAvatars();
        updateSettingsUI();
        updatePlisUI(); updateTrickProgress();
        renderHandsUI();

        // Restauration automatique si une partie était en cours avant le rafraîchissement d'écran
        loadActiveGameState();

