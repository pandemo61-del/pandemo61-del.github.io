// The original complete game module is kept at this immutable revision. Load it,
// along with its original inline styles, while this split is repaired/maintained.
const ORIGINAL_PAGE_URL = 'https://raw.githubusercontent.com/pandemo61-del/AllWhist/f9e90bcc0fec695eed2e2aedabae9f0f94ca98c5/web/play.html';

function renderPlayerBids() {
    for (let playerId = 0; playerId < 4; playerId++) {
        const pill = document.getElementById(`bid-j${playerId}`);
        if (!pill) continue;

        const lastAction = [...historiqueEncheres].reverse().find(action => action.joueurId === playerId);
        if (!lastAction) {
            pill.textContent = '—';
            pill.className = 'bid-pill neutral';
            continue;
        }
        if (lastAction.action === 'passe') {
            pill.textContent = 'Passe';
            pill.className = 'bid-pill pass';
            continue;
        }

        const bid = lastAction.contrat;
        let label = bid?.nom || 'Enchère';
        if (bid?.sa) label += ' · Sans atout';
        else if (bid?.atout && SYM[bid.atout]) label += ` · ${SYM[bid.atout]}`;
        pill.textContent = label;
        pill.className = `bid-pill ${meilleureEnchere?.joueurId === playerId ? 'winning' : 'bid'}`;
    }
}

function installBidDisplay(source) {
    source = source.replace(
        '        const btnStart = document.getElementById(\'btn-start\');',
        `        ${renderPlayerBids.toString()}` + '\n\n        const btnStart = document.getElementById(\'btn-start\');'
    );

    source = source.replace(
        '            historiqueEncheres = [];',
        '            historiqueEncheres = [];\n            renderPlayerBids();'
    );
    source = source.replace(
        "                    historiqueEncheres.push({ joueurId: id, action: 'enchere', contrat: { ...meilleureEnchere } });",
        "                    historiqueEncheres.push({ joueurId: id, action: 'enchere', contrat: { ...meilleureEnchere } });\n                    renderPlayerBids();"
    );
    source = source.replace(
        "            historiqueEncheres.push({ joueurId: playerId, action: 'passe' });",
        "            historiqueEncheres.push({ joueurId: playerId, action: 'passe' });\n            renderPlayerBids();"
    );
    source = source.replace(
        "            historiqueEncheres.push({ joueurId: 0, action: 'enchere', contrat: { ...meilleureEnchere } });",
        "            historiqueEncheres.push({ joueurId: 0, action: 'enchere', contrat: { ...meilleureEnchere } });\n            renderPlayerBids();"
    );
    source = source.replace(
        '            if (scenarioId && meilleureEnchere) {\n                finaliserEnchere();',
        "            if (scenarioId && meilleureEnchere) {\n                historiqueEncheres.push({ joueurId: meilleureEnchere.joueurId, action: 'enchere', contrat: { ...meilleureEnchere } });\n                renderPlayerBids();\n                finaliserEnchere();"
    );
    source = source.replace(
        '        updateSettingsUI();\n        updatePlisUI();\n        renderHandsUI();',
        '        updateSettingsUI();\n        updatePlisUI();\n        renderPlayerBids();\n        renderHandsUI();'
    );
    return source;
}

try {
    const response = await fetch(ORIGINAL_PAGE_URL);
    if (!response.ok) throw new Error(`Chargement du module de jeu impossible (${response.status}).`);

    const html = await response.text();
    const originalDocument = new DOMParser().parseFromString(html, 'text/html');
    for (const style of originalDocument.querySelectorAll('head style')) {
        document.head.appendChild(Object.assign(document.createElement('style'), { textContent: style.textContent }));
    }

    const originalModule = originalDocument.querySelector('script[type="module"]');
    if (!originalModule) throw new Error('Le script de jeu original est introuvable.');

    let source = installBidDisplay(originalModule.textContent);
    source = source
        .replaceAll("from './firebase-config.js'", `from '${new URL('./firebase-config.js', location.href).href}'`)
        .replaceAll("from '../shared/whist-contracts.js'", `from '${new URL('../shared/whist-contracts.js', location.href).href}'`)
        .replaceAll("from '../shared/whist-ai.js'", `from '${new URL('../shared/whist-ai.js', location.href).href}'`);

    const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
        await import(moduleUrl);
    } finally {
        URL.revokeObjectURL(moduleUrl);
    }
} catch (error) {
    console.error('Erreur de chargement du jeu AllWhist :', error);
    const message = document.getElementById('game-message-bar');
    const text = document.getElementById('game-message-text');
    if (message && text) {
        text.textContent = 'Le jeu n’a pas pu être chargé. Vérifiez la connexion puis rechargez la page.';
        message.classList.remove('hidden');
    }
}
