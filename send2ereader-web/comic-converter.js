const fs = require('fs');
const os = require('os');
const path = require('path');
const { finished, pipeline } = require('stream/promises');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const unzipper = require('unzipper');
const { createExtractorFromFile } = require('node-unrar-js');

const MAX_COMIC_PAGES = 500;
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_OUTPUT_PANELS = 2000;
const SUPPORTED_IMAGE = /\.(jpe?g|png|webp)$/i;
const READER_PROFILES = Object.freeze({
  'kobo-clara-colour': { name: 'Kobo Clara Colour', width: 1072, height: 1448, ppi: 300 },
  'kobo-clara-bw': { name: 'Kobo Clara BW', width: 1072, height: 1448, ppi: 300 },
  'kobo-libra-colour': { name: 'Kobo Libra Colour', width: 1264, height: 1680, ppi: 300 },
  'kindle-paperwhite': { name: 'Kindle Paperwhite (2024)', width: 1264, height: 1680, ppi: 300 },
  'kindle-scribe': { name: 'Kindle Scribe', width: 1860, height: 2480, ppi: 300 }
});

function resolveReaderProfile(profileId, customWidth, customHeight) {
  if (profileId === 'custom') {
    const width = Number(customWidth);
    const height = Number(customHeight);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 400 || width > 10000 || height < 400 || height > 10000) {
      throw new Error('Custom e-reader resolution must be between 400 and 10000 pixels for each side.');
    }
    return { name: 'Custom e-reader', width, height, ppi: 300 };
  }

  const profile = READER_PROFILES[profileId];
  if (!profile) throw new Error('Choose a valid e-reader profile for panel conversion.');
  return profile;
}

function compareArchiveNames(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function validateArchiveContents(entries) {
  const imageEntries = entries.filter((entry) => {
    const name = entry.name || entry.path;
    return entry.type !== 'Directory' && !entry.flags?.directory && SUPPORTED_IMAGE.test(name || '');
  });

  const unpackedBytes = entries.reduce((total, entry) => {
    if (entry.type === 'Directory' || entry.flags?.directory) return total;
    return total + Number(entry.uncompressedSize ?? entry.unpSize ?? 0);
  }, 0);

  if (unpackedBytes > MAX_UNPACKED_BYTES) {
    throw new Error('The comic archive is too large after extraction (500 MB limit).');
  }
  if (imageEntries.length === 0) {
    throw new Error('No supported comic images were found in the archive.');
  }
  if (imageEntries.length > MAX_COMIC_PAGES) {
    throw new Error(`The comic contains too many pages (maximum ${MAX_COMIC_PAGES}).`);
  }

  return imageEntries.sort((left, right) => compareArchiveNames(left.name || left.path, right.name || right.path));
}

async function extractZipPages(inputPath, targetPath) {
  const archive = await unzipper.Open.file(inputPath);
  const imageEntries = validateArchiveContents(archive.files);
  const imagePaths = [];

  for (const [index, entry] of imageEntries.entries()) {
    const extension = path.extname(entry.path).toLowerCase();
    const imagePath = path.join(targetPath, `page-${String(index).padStart(5, '0')}${extension}`);
    await pipeline(entry.stream(), fs.createWriteStream(imagePath, { flags: 'wx' }));
    imagePaths.push(imagePath);
  }

  return imagePaths;
}

async function extractRarPages(inputPath, targetPath) {
  const namesByPath = new Map();
  const extractor = await createExtractorFromFile({
    filepath: inputPath,
    targetPath,
    filenameTransform: (name) => namesByPath.get(name) || path.basename(name.replace(/\\/g, '/'))
  });
  const entries = [...extractor.getFileList().fileHeaders];
  const imageEntries = validateArchiveContents(entries);

  if (imageEntries.some((entry) => entry.flags?.encrypted)) {
    throw new Error('Password-protected comic archives are not supported.');
  }

  imageEntries.forEach((entry, index) => {
    namesByPath.set(entry.name, `page-${String(index).padStart(5, '0')}${path.extname(entry.name).toLowerCase()}`);
  });

  const extraction = extractor.extract({
    files: (entry) => namesByPath.has(entry.name)
  });
  [...extraction.files];

  return imageEntries.map((entry) => path.join(targetPath, namesByPath.get(entry.name)));
}

function findRuns(start, end, matches, minimumLength, maximumLength) {
  const runs = [];
  let runStart = -1;

  for (let position = start; position < end; position += 1) {
    const matched = matches(position);
    if (matched && runStart === -1) runStart = position;

    if ((!matched || position === end - 1) && runStart !== -1) {
      const runEnd = matched && position === end - 1 ? position : position - 1;
      const length = runEnd - runStart + 1;
      if (length >= minimumLength && length <= maximumLength) {
        runs.push({ start: runStart, end: runEnd });
      }
      runStart = -1;
    }
  }

  return runs;
}

function mergeNearbyRuns(runs, maximumGap) {
  const merged = [];

  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && run.start - previous.end - 1 <= maximumGap) {
      previous.end = run.end;
    } else {
      merged.push({ ...run });
    }
  }

  return merged;
}

function splitRange(length, gaps) {
  const ranges = [];
  let start = 0;

  for (const gap of gaps) {
    if (gap.start > start) ranges.push({ start, end: gap.start });
    start = gap.end + 1;
  }

  if (start < length) ranges.push({ start, end: length });
  return ranges;
}

function hasGutterColor(data, width, fixedPosition, sampleStart, sampleEnd, step, horizontal, darkRatio, lightRatio) {
  let sampleCount = 0;
  let darkCount = 0;
  let lightCount = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;

  for (let position = sampleStart; position < sampleEnd; position += step) {
    const index = (horizontal ? fixedPosition * width + position : position * width + fixedPosition) * 3;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const value = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    sampleCount += 1;
    if (value < 28) darkCount += 1;
    if (value > 228) lightCount += 1;
    redTotal += red;
    greenTotal += green;
    blueTotal += blue;
  }

  if (!sampleCount) return false;
  if (darkCount / sampleCount > darkRatio || lightCount / sampleCount > lightRatio) return true;

  const averageRed = redTotal / sampleCount;
  const averageGreen = greenTotal / sampleCount;
  const averageBlue = blueTotal / sampleCount;
  let colorMatches = 0;
  for (let position = sampleStart; position < sampleEnd; position += step) {
    const index = (horizontal ? fixedPosition * width + position : position * width + fixedPosition) * 3;
    if (Math.abs(data[index] - averageRed) <= 16
      && Math.abs(data[index + 1] - averageGreen) <= 16
      && Math.abs(data[index + 2] - averageBlue) <= 16) {
      colorMatches += 1;
    }
  }

  return colorMatches / sampleCount > 0.85;
}

function findFooterPageNumberRects(data, width, height) {
  const startY = Math.floor(height * 0.93);
  const bandHeight = height - startY;
  const visited = new Uint8Array(width * bandHeight);
  const components = [];

  for (let bandY = 0; bandY < bandHeight; bandY += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = bandY * width + x;
      if (visited[startIndex]) continue;

      const pixelIndex = (startY + bandY) * width * 3 + x * 3;
      const red = data[pixelIndex];
      const green = data[pixelIndex + 1];
      const blue = data[pixelIndex + 2];
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      if (luminance >= 150 || Math.max(red, green, blue) - Math.min(red, green, blue) > 75) {
        visited[startIndex] = 1;
        continue;
      }

      const stack = [startIndex];
      visited[startIndex] = 1;
      let minX = x;
      let maxX = x;
      let minY = bandY;
      let maxY = bandY;
      let pixelCount = 0;

      while (stack.length) {
        const current = stack.pop();
        const currentY = Math.floor(current / width);
        const currentX = current - currentY * width;
        pixelCount += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);

        for (let neighborY = Math.max(0, currentY - 1); neighborY <= Math.min(bandHeight - 1, currentY + 1); neighborY += 1) {
          for (let neighborX = Math.max(0, currentX - 1); neighborX <= Math.min(width - 1, currentX + 1); neighborX += 1) {
            const neighbor = neighborY * width + neighborX;
            if (visited[neighbor]) continue;

            const neighborPixel = (startY + neighborY) * width * 3 + neighborX * 3;
            const neighborRed = data[neighborPixel];
            const neighborGreen = data[neighborPixel + 1];
            const neighborBlue = data[neighborPixel + 2];
            const neighborLuminance = neighborRed * 0.2126 + neighborGreen * 0.7152 + neighborBlue * 0.0722;
            visited[neighbor] = 1;
            if (neighborLuminance < 150
              && Math.max(neighborRed, neighborGreen, neighborBlue) - Math.min(neighborRed, neighborGreen, neighborBlue) <= 75) {
              stack.push(neighbor);
            }
          }
        }
      }

      const rectWidth = maxX - minX + 1;
      const rectHeight = maxY - minY + 1;
      if (pixelCount >= 4
        && rectWidth <= width * 0.08
        && rectHeight >= height * 0.004
        && rectHeight <= height * 0.035
        && pixelCount <= width * height * 0.002) {
        components.push({
          left: minX,
          top: startY + minY,
          right: maxX + 1,
          bottom: startY + maxY + 1,
          pixelCount
        });
      }
    }
  }

  const groups = [];
  for (const component of components) {
    const group = groups.find((candidate) => {
      const verticalGap = Math.max(0, candidate.top - component.bottom, component.top - candidate.bottom);
      const horizontalGap = Math.max(0, candidate.left - component.right, component.left - candidate.right);
      return verticalGap <= height * 0.01 && horizontalGap <= height * 0.015;
    });
    if (group) {
      group.left = Math.min(group.left, component.left);
      group.top = Math.min(group.top, component.top);
      group.right = Math.max(group.right, component.right);
      group.bottom = Math.max(group.bottom, component.bottom);
      group.pixelCount += component.pixelCount;
      group.componentCount += 1;
    } else {
      groups.push({ ...component, componentCount: 1 });
    }
  }

  return groups
    .filter((group) => {
      const rectWidth = group.right - group.left;
      const rectHeight = group.bottom - group.top;
      return rectWidth <= width * 0.12
        && rectHeight <= height * 0.035
        && group.pixelCount <= width * height * 0.002
        && (group.componentCount >= 2
          || (group.top >= height * 0.95 && rectWidth >= width * 0.004 && rectHeight >= height * 0.006));
    })
    .map((group) => {
      const left = Math.max(0, group.left - 2);
      const top = Math.max(startY, group.top - 2);
      const right = Math.min(width, group.right + 2);
      const bottom = Math.min(height, group.bottom + 2);
      return { left, top, width: right - left, height: bottom - top };
    });
}

function computeBdPanelCount(width, height, readerProfile) {
  const area = width * height;
  const screenArea = readerProfile.width * readerProfile.height;
  if (screenArea >= 2_100_000) return 1;
  if (screenArea >= 1_400_000) return 2;
  if (screenArea >= 900_000) return 3;
  return 4;
}

function mergePanelsIntoTarget(panels, targetCount) {
  if (panels.length <= targetCount || !panels.length) {
    return panels.length ? panels : [{ left: 0, top: 0, width: 0, height: 0 }];
  }

  const groups = panels.map((panel) => [panel]);
  while (groups.length > targetCount) {
    let bestIndex = -1;
    let bestMerge = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index < groups.length - 1; index += 1) {
      const left = groups[index];
      const right = groups[index + 1];
      const merged = [...left, ...right];
      const bounds = merged.reduce((acc, panel) => ({
        left: Math.min(acc.left, panel.left),
        top: Math.min(acc.top, panel.top),
        right: Math.max(acc.right, panel.left + panel.width),
        bottom: Math.max(acc.bottom, panel.top + panel.height)
      }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      const width = bounds.right - bounds.left;
      const height = bounds.bottom - bounds.top;
      const score = width * height;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
        bestMerge = merged;
      }
    }

    if (bestIndex === -1 || !bestMerge) break;
    groups.splice(bestIndex, 2, bestMerge);
  }

  return groups.map((group) => {
    const bounds = group.reduce((acc, panel) => ({
      left: Math.min(acc.left, panel.left),
      top: Math.min(acc.top, panel.top),
      right: Math.max(acc.right, panel.left + panel.width),
      bottom: Math.max(acc.bottom, panel.top + panel.height)
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top
    };
  });
}

function detectPanelRegions(data, width, height) {
  const sampleStep = 4;
  const horizontalGaps = mergeNearbyRuns(findRuns(
    Math.floor(height * 0.02),
    Math.ceil(height * 0.98),
    (y) => hasGutterColor(data, width, y, Math.floor(width * 0.02), Math.ceil(width * 0.98), sampleStep, true, 0.82, 0.9),
    2,
    Math.min(80, Math.ceil(height * 0.02))
  ), 8);

  const rowRanges = splitRange(height, horizontalGaps);
  const panels = [];

  for (const row of rowRanges) {
    const verticalGaps = findRuns(
      Math.floor(width * 0.08),
      Math.ceil(width * 0.92),
      (x) => hasGutterColor(data, width, x, row.start, row.end, sampleStep, false, 0.76, 0.93),
      8,
      Math.min(70, Math.ceil(width * 0.025))
    ).filter((gap) => {
      const center = (gap.start + gap.end) / 2;
      return center > width * 0.1 && center < width * 0.88;
    });

    for (const column of splitRange(width, verticalGaps)) {
      const panel = {
        left: column.start,
        top: row.start,
        width: column.end - column.start,
        height: row.end - row.start
      };
      if (panel.width >= width * 0.1 && panel.height >= height * 0.06) {
        panels.push(panel);
      }
    }
  }

  return panels.length ? panels : [{ left: 0, top: 0, width, height }];
}

function buildBdPanels(data, width, height, readerProfile) {
  const detectedPanels = detectPanelRegions(data, width, height).filter((panel) => {
    const panelWidthRatio = panel.width / width;
    const panelHeightRatio = panel.height / height;
    return panelWidthRatio >= 0.12 && panelHeightRatio >= 0.10;
  });

  if (detectedPanels.length <= 1) {
    return [{ left: 0, top: 0, width, height }];
  }

  const targetCount = computeBdPanelCount(width, height, readerProfile);
  return mergePanelsIntoTarget(detectedPanels, Math.min(targetCount, detectedPanels.length));
}

function findPanelRegions(data, width, height, layoutMode = 'panel', readerProfile = { width, height }) {
  if (layoutMode === 'bd') {
    return buildBdPanels(data, width, height, readerProfile);
  }

  return detectPanelRegions(data, width, height);
}

async function convertComicToPdf(inputPath, outputPath, profileId = 'kobo-clara-colour', customWidth, customHeight, options = {}) {
  const layoutMode = options.layoutMode === 'bd' ? 'bd' : 'panel';
  const readerProfile = resolveReaderProfile(profileId, customWidth, customHeight);
  const workPath = fs.mkdtempSync(path.join(os.tmpdir(), 'send2ereader-comic-'));
  let document;
  let outputStream;
  let outputFinished;

  try {
    const imagePath = path.join(workPath, 'images');
    fs.mkdirSync(imagePath);

    const extension = path.extname(inputPath).toLowerCase();
    const pagePaths = extension === '.cbz'
      ? await extractZipPages(inputPath, imagePath)
      : await extractRarPages(inputPath, imagePath);

    document = new PDFDocument({ autoFirstPage: false, compress: true });
    outputStream = fs.createWriteStream(outputPath, { flags: 'wx' });
    document.on('error', (error) => outputStream.destroy(error));
    document.pipe(outputStream);
    outputFinished = finished(outputStream);

    let panelCount = 0;
    for (const [pageIndex, comicPagePath] of pagePaths.entries()) {
      const metadata = await sharp(comicPagePath).metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > 80000000) {
        throw new Error(`Comic page ${pageIndex + 1} has invalid or excessive image dimensions.`);
      }

      const scan = await sharp(comicPagePath).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pageNumberRects = findFooterPageNumberRects(scan.data, scan.info.width, scan.info.height);
      let pageImagePath = comicPagePath;
      if (pageNumberRects.length) {
        for (const rect of pageNumberRects) {
          for (let y = rect.top; y < rect.top + rect.height; y += 1) {
            for (let x = rect.left; x < rect.left + rect.width; x += 1) {
              const index = (y * scan.info.width + x) * 3;
              scan.data[index] = 255;
              scan.data[index + 1] = 255;
              scan.data[index + 2] = 255;
            }
          }
        }

        pageImagePath = path.join(workPath, `folio-clean-${String(pageIndex).padStart(5, '0')}.png`);
        await sharp(scan.data, {
          raw: { width: scan.info.width, height: scan.info.height, channels: 3 }
        }).png().toFile(pageImagePath);
      }
      const detectedPanels = pageIndex < 2
        ? [{ left: 0, top: 0, width: metadata.width, height: metadata.height }]
        : findPanelRegions(scan.data, scan.info.width, scan.info.height, layoutMode, readerProfile);
      const scaleX = metadata.width / scan.info.width;
      const scaleY = metadata.height / scan.info.height;
      const panels = detectedPanels.map((panel) => {
        const left = Math.floor(panel.left * scaleX);
        const top = Math.floor(panel.top * scaleY);
        const right = Math.min(metadata.width, Math.ceil((panel.left + panel.width) * scaleX));
        const bottom = Math.min(metadata.height, Math.ceil((panel.top + panel.height) * scaleY));
        return { left, top, width: right - left, height: bottom - top };
      });

      for (const panel of panels) {
        panelCount += 1;
        if (panelCount > MAX_OUTPUT_PANELS) {
          throw new Error(`The conversion creates too many pages (maximum ${MAX_OUTPUT_PANELS}).`);
        }

        const isLandscape = panel.width / panel.height > readerProfile.width / readerProfile.height;
        const pagePixelWidth = isLandscape ? readerProfile.height : readerProfile.width;
        const pagePixelHeight = isLandscape ? readerProfile.width : readerProfile.height;
        const panelPath = path.join(workPath, `panel-${String(panelCount).padStart(5, '0')}.jpg`);
        await sharp(pageImagePath)
          .extract(panel)
          .resize(pagePixelWidth, pagePixelHeight, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 }
          })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 90 })
          .toFile(panelPath);

        const pageWidth = pagePixelWidth * 72 / readerProfile.ppi;
        const pageHeight = pagePixelHeight * 72 / readerProfile.ppi;
        document.addPage({ size: [pageWidth, pageHeight], margin: 0 });
        document.image(panelPath, 0, 0, { width: pageWidth, height: pageHeight });
      }
    }

    document.end();
    await outputFinished;
    return panelCount;
  } catch (error) {
    document?.destroy(error);
    outputStream?.destroy(error);
    if (outputFinished) await outputFinished.catch(() => {});
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw error;
  } finally {
    fs.rmSync(workPath, { recursive: true, force: true });
  }
}

module.exports = { convertComicToPdf, findPanelRegions, findFooterPageNumberRects, READER_PROFILES, resolveReaderProfile };