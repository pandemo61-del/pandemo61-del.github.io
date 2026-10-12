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
const MAX_PANEL_DETECTION_SIDE = 1800;
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

function toGrayscale(data, width, height) {
  const gray = new Uint8Array(width * height);
  for (let pixel = 0, channel = 0; pixel < gray.length; pixel += 1, channel += 3) {
    gray[pixel] = Math.round(data[channel] * 0.299 + data[channel + 1] * 0.587 + data[channel + 2] * 0.114);
  }
  return gray;
}

function localMean(gray, width, height, kernelSize) {
  const horizontal = new Uint32Array(width * height);
  const means = new Uint8Array(width * height);
  const radius = Math.floor(kernelSize / 2);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x <= Math.min(width - 1, radius); x += 1) sum += gray[row + x];
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum;
      const leaving = x - radius;
      const entering = x + radius + 1;
      if (leaving >= 0) sum -= gray[row + leaving];
      if (entering < width) sum += gray[row + entering];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = 0; y <= Math.min(height - 1, radius); y += 1) sum += horizontal[y * width + x];
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height, y + radius + 1);
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      means[y * width + x] = Math.round(sum / ((bottom - top) * (right - left)));
      const leaving = y - radius;
      const entering = y + radius + 1;
      if (leaving >= 0) sum -= horizontal[leaving * width + x];
      if (entering < height) sum += horizontal[entering * width + x];
    }
  }
  return means;
}

function morphBinary(source, width, height, kernelSize, dilate) {
  const horizontal = new Uint8Array(width * height);
  const output = new Uint8Array(width * height);
  const radius = Math.floor(kernelSize / 2);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x <= Math.min(width - 1, radius); x += 1) count += source[row + x];
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      horizontal[row + x] = dilate ? Number(count > 0) : Number(count === right - left);
      const leaving = x - radius;
      const entering = x + radius + 1;
      if (leaving >= 0) count -= source[row + leaving];
      if (entering < width) count += source[row + entering];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y <= Math.min(height - 1, radius); y += 1) count += horizontal[y * width + x];
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height, y + radius + 1);
      output[y * width + x] = dilate ? Number(count > 0) : Number(count === bottom - top);
      const leaving = y - radius;
      const entering = y + radius + 1;
      if (leaving >= 0) count -= horizontal[leaving * width + x];
      if (entering < height) count += horizontal[entering * width + x];
    }
  }
  return output;
}

function cleanBinaryMask(mask, width, height, kernelSize) {
  const closed = morphBinary(morphBinary(mask, width, height, kernelSize, true), width, height, kernelSize, false);
  return morphBinary(morphBinary(closed, width, height, kernelSize, false), width, height, kernelSize, true);
}

function findBinaryComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const components = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let stackLength = 1;
    stack[0] = start;
    visited[start] = 1;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    let pixelCount = 0;

    while (stackLength) {
      const pixel = stack[--stackLength];
      const y = Math.floor(pixel / width);
      const x = pixel - y * width;
      pixelCount += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);

      for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(height - 1, y + 1); neighborY += 1) {
        const row = neighborY * width;
        for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(width - 1, x + 1); neighborX += 1) {
          const neighbor = row + neighborX;
          if (mask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            stack[stackLength++] = neighbor;
          }
        }
      }
    }

    components.push({
      left,
      top,
      width: right - left + 1,
      height: bottom - top + 1,
      pixelCount
    });
  }
  return components;
}

function calculateMaskConfidence(mask, width, panel) {
  let foregroundPixels = 0;
  for (let y = panel.top; y < panel.top + panel.height; y += 1) {
    for (let x = panel.left; x < panel.left + panel.width; x += 1) {
      foregroundPixels += mask[y * width + x];
    }
  }
  return foregroundPixels / (panel.width * panel.height);
}

function detectPanelsAdaptiveThreshold(gray, width, height, isDarkBackground, minPanelSize) {
  const blockSize = isDarkBackground ? 15 : 11;
  const offset = isDarkBackground ? 5 : 2;
  const means = localMean(gray, width, height, blockSize);
  const threshold = new Uint8Array(gray.length);

  for (let pixel = 0; pixel < threshold.length; pixel += 1) {
    const isBright = gray[pixel] > means[pixel] - offset;
    threshold[pixel] = Number(isDarkBackground ? isBright : !isBright);
  }

  const mask = cleanBinaryMask(threshold, width, height, 3);
  return findBinaryComponents(mask, width, height)
    .filter((panel) => panel.width >= minPanelSize
      && panel.height >= minPanelSize
      && panel.width * panel.height < width * height * 0.9)
    .map((panel) => ({ ...panel, confidence: calculateMaskConfidence(mask, width, panel) }))
    .filter((panel) => panel.confidence > 0.1);
}

function intersectionOverUnion(first, second) {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.left + first.width, second.left + second.width);
  const bottom = Math.min(first.top + first.height, second.top + second.height);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  return intersection / (first.width * first.height + second.width * second.height - intersection);
}

function removeDuplicatePanels(panels) {
  const unique = [];
  for (const panel of panels.sort((first, second) => second.confidence - first.confidence)) {
    if (!unique.some((existing) => intersectionOverUnion(panel, existing) > 0.5)) unique.push(panel);
  }
  return unique;
}

function extendTruncatedPanels(panels, height, yTolerance) {
  if (panels.length < 2) return panels;
  const sorted = [...panels].sort((first, second) => first.top - second.top || first.left - second.left);
  const rows = [];
  for (const panel of sorted) {
    if (!rows.length || Math.abs(panel.top - rows[rows.length - 1][0].top) >= yTolerance) rows.push([panel]);
    else rows[rows.length - 1].push(panel);
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.length < 2) continue;
    const heights = row.map((panel) => panel.height).sort((first, second) => first - second);
    const medianHeight = heights[Math.floor(heights.length / 2)];
    const targetHeight = heights[heights.length - 1];
    if (targetHeight > medianHeight * 1.1) continue;
    let extendedBottom = 0;
    for (const panel of row) extendedBottom = Math.max(extendedBottom, panel.top + targetHeight);
    if (rowIndex + 1 < rows.length && extendedBottom > rows[rowIndex + 1][0].top) continue;

    for (const panel of row) {
      if (panel.height < targetHeight * 0.8) panel.height = Math.min(targetHeight, height - panel.top);
    }
  }
  return panels;
}

function detectPanelRegions(data, width, height, minPanelSize = 100, yTolerance = 20) {
  const gray = toGrayscale(data, width, height);
  const isDarkBackground = gray.reduce((sum, value) => sum + value, 0) / gray.length < 127;

  const panels = detectPanelsAdaptiveThreshold(gray, width, height, isDarkBackground, minPanelSize);

  if (panels.length === 0) {
    return [{ left: 0, top: 0, width, height }];
  }

  const candidates = removeDuplicatePanels(panels)
    .sort((first, second) => first.top - second.top || first.left - second.left);

  return extendTruncatedPanels(candidates, height, yTolerance)
    .map(({ confidence, pixelCount, ...panel }) => panel);
}

function sortPanelsForReadingOrder(panels) {
  if (panels.length === 0) return [];
  if (panels.length === 1) return panels;

  function bounds(panel, axis) {
    if (axis === 1) return [panel.top, panel.top + panel.height];
    return [panel.left, panel.left + panel.width];
  }

  function split(items, axis) {
    const ordered = [...items].sort((a, b) => bounds(a, axis)[0] - bounds(b, axis)[0]);
    const low = Math.min(...ordered.map(p => bounds(p, axis)[0]));
    const high = Math.max(...ordered.map(p => bounds(p, axis)[1]));
    const tolerance = (high - low) * 0.015;
    const groups = [];
    let currentGroup = [ordered[0]];
    let groupEnd = bounds(ordered[0], axis)[1];

    for (const panel of ordered.slice(1)) {
      const [start, end] = bounds(panel, axis);
      if (start >= groupEnd - tolerance) {
        groups.push(currentGroup);
        currentGroup = [panel];
        groupEnd = end;
      } else {
        currentGroup.push(panel);
        groupEnd = Math.max(groupEnd, end);
      }
    }
    if (currentGroup.length) groups.push(currentGroup);
    return groups;
  }

  function byRows(items) {
    const ordered = [...items].sort((a, b) => a.top - b.top || a.left - b.left);
    const heights = ordered.map(p => p.height).sort((a, b) => a - b);
    const heightMedian = heights[Math.floor(heights.length / 2)];
    const tolerance = 0.15 * heightMedian;
    const rows = [];

    for (const panel of ordered) {
      if (rows.length && panel.top - rows[rows.length - 1][0].top <= tolerance) {
        rows[rows.length - 1].push(panel);
      } else {
        rows.push([panel]);
      }
    }

    return rows.flatMap(row => row.sort((a, b) => a.left - b.left));
  }

  function order(items) {
    if (items.length <= 1) return items;

    const horizontalGroups = split(items, 1);
    if (horizontalGroups.length > 1) {
      return horizontalGroups.flatMap(g => order(g));
    }

    const verticalGroups = split(items, 0);
    if (verticalGroups.length > 1) {
      return verticalGroups.flatMap(g => order(g));
    }

    return byRows(items);
  }

  return order(panels);
}

function findPanelRegionsForLayout(data, width, height, layoutMode = 'panel', minPanelSize = 100, yTolerance = 20) {
  const panels = detectPanelRegions(data, width, height, minPanelSize, yTolerance);

  if (layoutMode === 'bd') {
    const filtered = panels.filter((panel) => {
      const panelWidthRatio = panel.width / width;
      const panelHeightRatio = panel.height / height;
      return panelWidthRatio >= 0.12 && panelHeightRatio >= 0.10;
    });
    return filtered.length > 1 ? filtered : [{ left: 0, top: 0, width, height }];
  }

  return sortPanelsForReadingOrder(panels);
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

      let detectedPanels;
      if (pageIndex < 2) {
        detectedPanels = [{ left: 0, top: 0, width: metadata.width, height: metadata.height }];
      } else {
        const detection = await sharp(scan.data, {
          raw: { width: scan.info.width, height: scan.info.height, channels: 3 }
        })
          .resize(MAX_PANEL_DETECTION_SIDE, MAX_PANEL_DETECTION_SIDE, { fit: 'inside', withoutEnlargement: true })
          .raw()
          .toBuffer({ resolveWithObject: true });

        const detectionScaleX = scan.info.width / detection.info.width;
        const detectionScaleY = scan.info.height / detection.info.height;

        const detectedAtScale = findPanelRegionsForLayout(
          detection.data,
          detection.info.width,
          detection.info.height,
          layoutMode,
          100 / Math.max(detectionScaleX, detectionScaleY),
          20 / detectionScaleY
        );

        detectedPanels = detectedAtScale.map((panel) => {
          const left = Math.floor(panel.left * detectionScaleX);
          const top = Math.floor(panel.top * detectionScaleY);
          const right = Math.min(scan.info.width, Math.ceil((panel.left + panel.width) * detectionScaleX));
          const bottom = Math.min(scan.info.height, Math.ceil((panel.top + panel.height) * detectionScaleY));
          return { left, top, width: right - left, height: bottom - top };
        });
      }

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
        const extractedPanel = await sharp(pageImagePath).extract(panel).toBuffer();
        const renderedPanel = await sharp(extractedPanel)
          .trim({ background: '#ffffff', threshold: 18, margin: 4 })
          .resize(pagePixelWidth, pagePixelHeight, {
            fit: 'inside'
          })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 90 })
          .toFile(panelPath);

        const pageWidth = renderedPanel.width * 72 / readerProfile.ppi;
        const pageHeight = renderedPanel.height * 72 / readerProfile.ppi;
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

module.exports = {
  convertComicToPdf,
  findPanelRegions: findPanelRegionsForLayout,
  findFooterPageNumberRects,
  sortPanelsForReadingOrder,
  READER_PROFILES,
  resolveReaderProfile
};
