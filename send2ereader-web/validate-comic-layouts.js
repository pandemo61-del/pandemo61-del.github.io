const fs = require('fs');
const path = require('path');
const os = require('os');
const { convertComicToPdf } = require('./comic-converter');
const {
  generateTestComicCBZ,
  PAGES,
  LAYOUT_PATTERNS
} = require('./test-comic-generator');

async function generateAndValidate() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-validation-'));
  const sourceCbz = path.join(tempRoot, 'test-50-pages.cbz');
  const outputPdf = path.join(tempRoot, 'test-50-pages.pdf');

  console.log('Génération de la BD de test...');
  await generateTestComicCBZ(sourceCbz);

  console.log('Conversion en PDF...');
  const panelCount = await convertComicToPdf(sourceCbz, outputPdf, 'kobo-clara-colour', null, null, {
    layoutMode: 'panel'
  });

  console.log('\nRésultat de conversion');
  console.log(`  • Pages de test: ${PAGES}`);
  console.log(`  • Motifs: ${LAYOUT_PATTERNS.length}`);
  console.log(`  • Panneaux produits: ${panelCount}`);
  console.log(`  • PDF: ${outputPdf}`);

  return { sourceCbz, outputPdf, panelCount };
}

if (require.main === module) {
  generateAndValidate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Erreur:', err);
      process.exit(1);
    });
}
