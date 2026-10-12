const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const sharp = require('sharp');
const archiver = require('archiver');

/**
 * Test Comic Generator
 * Génère une BD de 50 pages avec des découpages variés pour tester la détection
 */

const PAGES = 50;
const WIDTH = 1600;
const HEIGHT = 2400;
const DPI = 150;

// Patterns de mise en page variés
const LAYOUT_PATTERNS = [
  'single_panel',           // Page complète
  'two_row',                // 2 cases en hauteur
  'three_row',              // 3 cases en hauteur
  'four_panel_grid',        // Grille 2x2
  'six_panel_grid',         // Grille 3x2
  'nine_panel_grid',        // Grille 3x3
  'mixed_left_right',       // Gauche grande, droite 2x2
  'mixed_top_bottom',       // Haut 2 cases, bas 1 grande
  'diagonal',               // Cases diagonales
  'irregular'               // Disposition irrégulière
];

function drawText(ctx, text, x, y, maxWidth) {
  ctx.fillStyle = '#333333';
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y, maxWidth);
}

function drawPanel(ctx, left, top, width, height, pageNum, panelNum, color) {
  // Fond avec couleur aléatoire ou fixe
  ctx.fillStyle = color || `hsl(${Math.random() * 360}, 60%, 80%)`;
  ctx.fillRect(left, top, width, height);

  // Bordure sombre (pour faciliter la détection)
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 3;
  ctx.strokeRect(left, top, width, height);

  // Numéro du panel
  drawText(ctx, `P${pageNum}-${panelNum}`, left + width / 2, top + height / 2, width - 20);
}

function drawSinglePanel(ctx, pageNum) {
  drawPanel(ctx, 40, 40, WIDTH - 80, HEIGHT - 80, pageNum, 1, '#E8F4F8');
}

function drawTwoRow(ctx, pageNum) {
  const panelHeight = (HEIGHT - 80) / 2;
  drawPanel(ctx, 40, 40, WIDTH - 80, panelHeight - 20, pageNum, 1, '#FFE8E8');
  drawPanel(ctx, 40, panelHeight + 40, WIDTH - 80, panelHeight - 20, pageNum, 2, '#E8FFE8');
}

function drawThreeRow(ctx, pageNum) {
  const panelHeight = (HEIGHT - 80) / 3;
  drawPanel(ctx, 40, 40, WIDTH - 80, panelHeight - 15, pageNum, 1, '#FFE8E8');
  drawPanel(ctx, 40, panelHeight + 40, WIDTH - 80, panelHeight - 15, pageNum, 2, '#E8FFE8');
  drawPanel(ctx, 40, panelHeight * 2 + 40, WIDTH - 80, panelHeight - 15, pageNum, 3, '#E8E8FF');
}

function drawFourPanelGrid(ctx, pageNum) {
  const panelWidth = (WIDTH - 80) / 2;
  const panelHeight = (HEIGHT - 80) / 2;
  drawPanel(ctx, 40, 40, panelWidth - 20, panelHeight - 20, pageNum, 1, '#FFE8E8');
  drawPanel(ctx, panelWidth + 40, 40, panelWidth - 20, panelHeight - 20, pageNum, 2, '#E8FFE8');
  drawPanel(ctx, 40, panelHeight + 40, panelWidth - 20, panelHeight - 20, pageNum, 3, '#E8E8FF');
  drawPanel(ctx, panelWidth + 40, panelHeight + 40, panelWidth - 20, panelHeight - 20, pageNum, 4, '#FFFFE8');
}

function drawSixPanelGrid(ctx, pageNum) {
  const panelWidth = (WIDTH - 80) / 2;
  const panelHeight = (HEIGHT - 80) / 3;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      const panelNum = row * 2 + col + 1;
      const x = col * panelWidth + 40;
      const y = row * panelHeight + 40;
      const colors = ['#FFE8E8', '#E8FFE8', '#E8E8FF', '#FFFFE8', '#FFE8FF', '#E8FFFF'];
      drawPanel(ctx, x, y, panelWidth - 20, panelHeight - 15, pageNum, panelNum, colors[panelNum - 1]);
    }
  }
}

function drawNinePanelGrid(ctx, pageNum) {
  const panelWidth = (WIDTH - 80) / 3;
  const panelHeight = (HEIGHT - 80) / 3;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const panelNum = row * 3 + col + 1;
      const x = col * panelWidth + 40;
      const y = row * panelHeight + 40;
      const hue = (panelNum * 30) % 360;
      drawPanel(ctx, x, y, panelWidth - 15, panelHeight - 15, pageNum, panelNum, `hsl(${hue}, 70%, 80%)`);
    }
  }
}

function drawMixedLeftRight(ctx, pageNum) {
  const leftWidth = (WIDTH - 80) * 0.6;
  const rightWidth = (WIDTH - 80) * 0.4;
  const rightPanelHeight = (HEIGHT - 80) / 2;

  // Grand panel à gauche
  drawPanel(ctx, 40, 40, leftWidth - 20, HEIGHT - 80, pageNum, 1, '#FFE8E8');

  // 2 panels à droite
  drawPanel(ctx, leftWidth + 40, 40, rightWidth - 20, rightPanelHeight - 20, pageNum, 2, '#E8FFE8');
  drawPanel(ctx, leftWidth + 40, rightPanelHeight + 40, rightWidth - 20, rightPanelHeight - 20, pageNum, 3, '#E8E8FF');
}

function drawMixedTopBottom(ctx, pageNum) {
  const topPanelHeight = (HEIGHT - 80) * 0.4;
  const topPanelWidth = (WIDTH - 80) / 2;

  // 2 panels au-dessus
  drawPanel(ctx, 40, 40, topPanelWidth - 20, topPanelHeight - 20, pageNum, 1, '#FFE8E8');
  drawPanel(ctx, topPanelWidth + 40, 40, topPanelWidth - 20, topPanelHeight - 20, pageNum, 2, '#E8FFE8');

  // 1 grand panel en bas
  drawPanel(ctx, 40, topPanelHeight + 40, WIDTH - 80, HEIGHT - 80 - topPanelHeight - 20, pageNum, 3, '#E8E8FF');
}

function drawDiagonal(ctx, pageNum) {
  // Cases en diagonale
  const panelSize = 400;
  const spacing = (WIDTH - panelSize) / 3;
  for (let i = 0; i < 4; i += 1) {
    const x = spacing * (i + 1);
    const y = spacing * (i + 1);
    if (x + panelSize < WIDTH && y + panelSize < HEIGHT) {
      drawPanel(ctx, x, y, panelSize, panelSize, pageNum, i + 1, `hsl(${i * 90}, 70%, 80%)`);
    }
  }
}

function drawIrregular(ctx, pageNum) {
  // Disposition irrégulière mais lisible
  const colors = ['#FFE8E8', '#E8FFE8', '#E8E8FF', '#FFFFE8', '#FFE8FF', '#E8FFFF'];

  // Panel 1 : haut gauche (grand)
  drawPanel(ctx, 40, 40, 450, 500, pageNum, 1, colors[0]);

  // Panel 2 : haut droite
  drawPanel(ctx, 500, 40, WIDTH - 540, 250, pageNum, 2, colors[1]);

  // Panel 3 : haut droite (petit)
  drawPanel(ctx, 500, 300, WIDTH - 540, 240, pageNum, 3, colors[2]);

  // Panel 4 : bas gauche
  drawPanel(ctx, 40, 560, 450, HEIGHT - 600, pageNum, 4, colors[3]);

  // Panel 5 : bas milieu
  drawPanel(ctx, 500, 560, (WIDTH - 540) / 2 - 10, HEIGHT - 600, pageNum, 5, colors[4]);

  // Panel 6 : bas droite
  drawPanel(ctx, WIDTH / 2 + 30, 560, (WIDTH - 540) / 2 - 30, HEIGHT - 600, pageNum, 6, colors[5]);
}

const LAYOUT_FUNCTIONS = {
  single_panel: drawSinglePanel,
  two_row: drawTwoRow,
  three_row: drawThreeRow,
  four_panel_grid: drawFourPanelGrid,
  six_panel_grid: drawSixPanelGrid,
  nine_panel_grid: drawNinePanelGrid,
  mixed_left_right: drawMixedLeftRight,
  mixed_top_bottom: drawMixedTopBottom,
  diagonal: drawDiagonal,
  irregular: drawIrregular
};

async function generateTestComicPage(pageNum) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // Fond blanc
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Sélectionner un layout
  const layoutIndex = (pageNum - 1) % LAYOUT_PATTERNS.length;
  const layoutName = LAYOUT_PATTERNS[layoutIndex];
  const drawFunc = LAYOUT_FUNCTIONS[layoutName];

  // Dessiner la page
  drawFunc(ctx, pageNum);

  // Ajouter le numéro de page en bas
  ctx.fillStyle = '#999999';
  ctx.font = 'bold 16px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(`Page ${pageNum} (${layoutName})`, WIDTH / 2, HEIGHT - 20);

  // Convertir en buffer
  const buffer = await canvas.encode('png');
  return buffer;
}

async function generateTestComicCBZ(outputPath) {
  console.log(`📖 Génération de BD de test: ${outputPath}`);
  console.log(`📄 ${PAGES} pages avec ${LAYOUT_PATTERNS.length} motifs variés\n`);

  const tempDir = path.join(__dirname, 'temp-comic-pages');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Générer les pages PNG
  console.log('📝 Génération des pages PNG...');
  for (let i = 1; i <= PAGES; i += 1) {
    const buffer = await generateTestComicPage(i);
    const pagePath = path.join(tempDir, `page-${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(pagePath, buffer);

    if (i % 5 === 0) {
      console.log(`   ✓ ${i}/${PAGES} pages générées`);
    }
  }

  console.log(`   ✓ ${PAGES}/${PAGES} pages générées\n`);

  // Créer le CBZ (ZIP)
  console.log('📦 Création de l\'archive CBZ...');
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`   ✓ Archive créée: ${archive.pointer()} bytes\n`);

      // Nettoyer les fichiers temporaires
      console.log('🧹 Nettoyage des fichiers temporaires...');
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('   ✓ Fichiers temporaires supprimés\n');

      resolve(outputPath);
    });

    archive.on('error', reject);
    archive.pipe(output);

    // Ajouter toutes les pages PNG
    const pages = fs.readdirSync(tempDir).sort();
    for (const page of pages) {
      archive.file(path.join(tempDir, page), { name: page });
    }

    archive.finalize();
  });
}

async function generateTestComicCBZWithInfo(outputPath) {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║       TEST COMIC GENERATOR - 50 Pages BD de Test       ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  console.log('📊 Caractéristiques:');
  console.log(`   • Résolution: ${WIDTH}x${HEIGHT} px`);
  console.log(`   • Pages: ${PAGES}`);
  console.log(`   • Motifs: ${LAYOUT_PATTERNS.length}`);
  console.log(`   • Répétition cyclique des motifs\n`);

  console.log('🎨 Motifs de mise en page:');
  LAYOUT_PATTERNS.forEach((pattern, idx) => {
    const freq = Math.ceil(PAGES / LAYOUT_PATTERNS.length);
    console.log(`   ${idx + 1}. ${pattern.padEnd(20)} (~${freq} pages)`);
  });
  console.log('');

  try {
    const cbzPath = await generateTestComicCBZ(outputPath);
    console.log('✅ BD de test créée avec succès!\n');
    console.log(`📁 Fichier: ${cbzPath}`);
    console.log(`💾 Taille: ${(fs.statSync(cbzPath).size / 1024 / 1024).toFixed(2)} MB\n`);
    console.log('💡 Utilisation:');
    console.log(`   npm run test-convert -- ${cbzPath}`);
    console.log('');
    return cbzPath;
  } catch (error) {
    console.error('❌ Erreur lors de la génération:', error);
    throw error;
  }
}

// Export pour utilisation en tant que module ou CLI
if (require.main === module) {
  const outputPath = path.join(__dirname, 'test-comic-50pages.cbz');
  generateTestComicCBZWithInfo(outputPath).catch(error => {
    console.error('Fatal:', error);
    process.exit(1);
  });
}

module.exports = {
  generateTestComicCBZ,
  generateTestComicPage,
  LAYOUT_PATTERNS,
  PAGES,
  WIDTH,
  HEIGHT
};
