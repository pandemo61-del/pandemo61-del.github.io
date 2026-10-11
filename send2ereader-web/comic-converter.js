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

function panelBounds(panels) {
  return panels.reduce((bounds, panel) => ({
    left: Math.min(bounds.left, panel.left),
    top: Math.min(bounds.top, panel.top),
    right: Math.max(bounds.right, panel.left + panel.width),
    bottom: Math.max(bounds.bottom, panel.top + panel.height)
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
}

function squareAspectError(width, height) {
  return Math.abs(Math.log(width / height));
}

function areAdjacentPanels(first, second) {
  const firstRight = first.left + first.width;
  const secondRight = second.left + second.width;
  const firstBottom = first.top + first.height;
  const secondBottom = second.top + second.height;

  const verticalOverlap = Math.max(0, Math.min(firstBottom, secondBottom) - Math.max(first.top, second.top));
  const horizontalOverlap = Math.max(0, Math.min(firstRight, secondRight) - Math.max(first.left, second.left));
  const horizontalGap = Math.max(0, second.left - firstRight, first.left - secondRight);
  const verticalGap = Math.max(0, second.top - firstBottom, first.top - secondBottom);

  const sideBySide = verticalOverlap / Math.min(first.height, second.height) >= 0.5
    && horizontalGap <= Math.max(first.height, second.height) * 0.08;
  const stacked = horizontalOverlap / Math.min(first.width, second.width) >= 0.5
    && verticalGap <= Math.max(first.width, second.width) * 0.08;
  return sideBySide || stacked;
}

function groupBdPanels(panels) {
  const groups = [];
  for (let index = 0; index < panels.length; index += 1) {
    const current = panels[index];
    const currentError = squareAspectError(current.width, current.height);
    const next = panels[index + 1];

    if (currentError <= Math.log(1.35) || !next || !areAdjacentPanels(current, next)) {
      groups.push(current);
      continue;
    }

    const mergedBounds = panelBounds([current, next]);
    const mergedWidth = mergedBounds.right - mergedBounds.left;
    const mergedHeight = mergedBounds.bottom - mergedBounds.top;
    const mergedError = squareAspectError(mergedWidth, mergedHeight);
    if (mergedError < currentError && mergedError <= Math.log(1.6)) {
      groups.push({
        left: mergedBounds.left,
        top: mergedBounds.top,
        width: mergedWidth,
        height: mergedHeight
      });
      index += 1;
    } else {
      groups.push(current);
    }
  }
  return groups;
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

function calculateVariance(gray, width, panel) {
  let total = 0;
  let squaredTotal = 0;
  const pixelCount = panel.width * panel.height;
  for (let y = panel.top; y < panel.top + panel.height; y += 1) {
    for (let x = panel.left; x < panel.left + panel.width; x += 1) {
      const value = gray[y * width + x];
      total += value;
      squaredTotal += value * value;
    }
  }
  const mean = total / pixelCount;
  return squaredTotal / pixelCount - mean * mean;
}

function detectWithAdaptiveThreshold(gray, width, height, isDarkBackground, minPanelSize) {
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

function otsuThreshold(gray) {
  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value] += 1;
  const total = gray.length;
  let totalWeighted = 0;
  for (let value = 0; value < histogram.length; value += 1) totalWeighted += value * histogram[value];

  let backgroundCount = 0;
  let backgroundWeighted = 0;
  let bestVariance = -1;
  let threshold = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    backgroundCount += histogram[value];
    backgroundWeighted += value * histogram[value];
    const foregroundCount = total - backgroundCount;
    if (!backgroundCount || !foregroundCount) continue;
    const backgroundMean = backgroundWeighted / backgroundCount;
    const foregroundMean = (totalWeighted - backgroundWeighted) / foregroundCount;
    const variance = backgroundCount * foregroundCount * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  return threshold;
}

function detectWithOtsuThreshold(gray, width, height, isDarkBackground, minPanelSize) {
  const threshold = otsuThreshold(gray);
  const binary = new Uint8Array(gray.length);
  for (let pixel = 0; pixel < binary.length; pixel += 1) {
    const isBright = gray[pixel] > threshold;
    binary[pixel] = Number(isDarkBackground ? !isBright : isBright);
  }
  const mask = cleanBinaryMask(binary, width, height, 5);
  const pageArea = width * height;
  return findBinaryComponents(mask, width, height)
    .filter((panel) => panel.width >= minPanelSize
      && panel.height >= minPanelSize
      && Math.max(panel.width, panel.height) / Math.min(panel.width, panel.height) < 10
      && panel.width * panel.height < pageArea * 0.9)
    .map((panel) => ({ ...panel, confidence: 0.8 }));
}

function findCannyEdges(gray, width, height) {
  const length = gray.length;
  const horizontal = new Int16Array(length);
  const vertical = new Int16Array(length);
  const magnitude = new Uint16Array(length);
  const edgeState = new Uint8Array(length);

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = row + x;
      const top = index - width;
      const bottom = index + width;
      const gx = -gray[top - 1] + gray[top + 1] - 2 * gray[index - 1] + 2 * gray[index + 1]
        - gray[bottom - 1] + gray[bottom + 1];
      const gy = -gray[top - 1] - 2 * gray[top] - gray[top + 1]
        + gray[bottom - 1] + 2 * gray[bottom] + gray[bottom + 1];
      horizontal[index] = gx;
      vertical[index] = gy;
      magnitude[index] = Math.min(65535, Math.round(Math.hypot(gx, gy)));
    }
  }

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = row + x;
      const value = magnitude[index];
      if (value < 50) continue;
      const gx = horizontal[index];
      const gy = vertical[index];
      const absX = Math.abs(gx);
      const absY = Math.abs(gy);
      let before;
      let after;
      if (absY * 2 < absX) {
        before = magnitude[index - 1];
        after = magnitude[index + 1];
      } else if (absX * 2 < absY) {
        before = magnitude[index - width];
        after = magnitude[index + width];
      } else if (gx * gy > 0) {
        before = magnitude[index - width - 1];
        after = magnitude[index + width + 1];
      } else {
        before = magnitude[index - width + 1];
        after = magnitude[index + width - 1];
      }
      if (value >= before && value >= after) edgeState[index] = value >= 150 ? 2 : 1;
    }
  }

  const stack = new Int32Array(length);
  let stackLength = 0;
  for (let pixel = 0; pixel < length; pixel += 1) {
    if (edgeState[pixel] === 2) stack[stackLength++] = pixel;
  }
  while (stackLength) {
    const pixel = stack[--stackLength];
    const y = Math.floor(pixel / width);
    const x = pixel - y * width;
    for (let neighborY = Math.max(1, y - 1); neighborY <= Math.min(height - 2, y + 1); neighborY += 1) {
      const row = neighborY * width;
      for (let neighborX = Math.max(1, x - 1); neighborX <= Math.min(width - 2, x + 1); neighborX += 1) {
        const neighbor = row + neighborX;
        if (edgeState[neighbor] === 1) {
          edgeState[neighbor] = 2;
          stack[stackLength++] = neighbor;
        }
      }
    }
  }

  const edges = new Uint8Array(length);
  for (let pixel = 0; pixel < length; pixel += 1) edges[pixel] = Number(edgeState[pixel] === 2);
  return edges;
}

function detectWithBrightnessDifference(gray, width, height, minPanelSize) {
  let edges = findCannyEdges(gray, width, height);
  edges = morphBinary(morphBinary(edges, width, height, 3, true), width, height, 3, true);
  edges = morphBinary(morphBinary(edges, width, height, 7, true), width, height, 7, false);
  return findBinaryComponents(edges, width, height)
    .filter((panel) => panel.width >= minPanelSize && panel.height >= minPanelSize)
    .map((panel) => ({ ...panel, variance: calculateVariance(gray, width, panel) }))
    .filter((panel) => panel.variance > 100)
    .map(({ variance, ...panel }) => ({
      ...panel,
      confidence: Math.min(variance / 1000, 1)
    }));
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
  const adaptivePanels = detectWithAdaptiveThreshold(gray, width, height, isDarkBackground, minPanelSize);
  const otsuPanels = detectWithOtsuThreshold(gray, width, height, isDarkBackground, minPanelSize);
  const edgePanels = detectWithBrightnessDifference(gray, width, height, minPanelSize);
  const pageArea = width * height;
  const filteredOtsu = otsuPanels.filter((panel) => panel.width * panel.height < pageArea * 0.9);
  const filteredEdges = edgePanels.filter((panel) => panel.width * panel.height >= pageArea * 0.02
    || [...adaptivePanels, ...filteredOtsu].some((other) => intersectionOverUnion(panel, other) >= 0.3));
  const candidates = removeDuplicatePanels([...adaptivePanels, ...filteredOtsu, ...filteredEdges])
    .filter((panel) => panel.width * panel.height >= pageArea * 0.01)
    .sort((first, second) => first.top - second.top || first.left - second.left);
  const panels = extendTruncatedPanels(candidates, height, yTolerance);
  return panels.length
    ? panels.map(({ confidence, pixelCount, ...panel }) => panel)
    : [{ left: 0, top: 0, width, height }];
}

function buildBdPanels(data, width, height, minPanelSize, yTolerance) {
  const detectedPanels = detectPanelRegions(data, width, height, minPanelSize, yTolerance).filter((panel) => {
    const panelWidthRatio = panel.width / width;
    const panelHeightRatio = panel.height / height;
    return panelWidthRatio >= 0.12 && panelHeightRatio >= 0.10;
  });

  if (detectedPanels.length <= 1) {
    return [{ left: 0, top: 0, width, height }];
  }

  return groupBdPanels(detectedPanels);
}

function findPanelRegions(data, width, height, layoutMode = 'panel', minPanelSize = 100, yTolerance = 20) {
  if (layoutMode === 'bd') {
    return buildBdPanels(data, width, height, minPanelSize, yTolerance);
  }

  return detectPanelRegions(data, width, height, minPanelSize, yTolerance);
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
        const detectedAtScale = findPanelRegions(
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
  findPanelRegions,
  findFooterPageNumberRects,
  groupBdPanels,
  READER_PROFILES,
  resolveReaderProfile
};