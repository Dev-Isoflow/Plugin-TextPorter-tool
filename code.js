function findTextNodes(nodes, parentPath = '', topLevelFrameId = null) {
  const textNodes = [];

  for (const node of nodes) {
    const currentPath = parentPath ? `${parentPath} / ${node.name}` : node.name;

    let frameIdToUse = topLevelFrameId;
    if (node.type === 'FRAME' && topLevelFrameId === null) {
      frameIdToUse = node.id;
    }

    if (node.type === 'TEXT') {
      const fontName = Array.isArray(node.fontName) ? node.fontName[0] : node.fontName;
      textNodes.push({
        id: node.id,
        name: node.name,
        path: currentPath,
        characters: node.characters,
        fontName: fontName,
        parentFrameId: frameIdToUse
      });
    }

    if ('children' in node) {
      textNodes.push(...findTextNodes(node.children, currentPath, frameIdToUse));
    }
  }

  return textNodes;
}

function getTimestamp() {
  return new Date().toISOString().slice(0, 10);
}

async function handleExport(linkedMode) {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Please select one or more frames to export.' });
    return;
  }

  const allTextData = findTextNodes(selection);
  const filteredTextData = allTextData.filter(t => t.path.toLowerCase().indexOf('keyboard') === -1);

  if (filteredTextData.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'No text layers found in the selection.' });
    return;
  }

  const frameIdsSet = new Set(filteredTextData.map(t => t.parentFrameId).filter(Boolean));
  const frameNodes = selection.filter(n => n.type === 'FRAME' && frameIdsSet.has(n.id));

  const timestamp = Date.now();
  const figmaTimestamp = getTimestamp();

  const frames = [];
  for (const frame of frameNodes) {
    try {
      const imageBytes = await frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
      const base64 = figma.base64Encode(imageBytes);
      frames.push({ id: frame.id, name: frame.name, base64 });
    } catch (e) {
      console.error('Failed to export frame ' + frame.name + ': ' + e);
    }
  }

  const textNodes = filteredTextData.map(t => {
    const fontName = Array.isArray(t.fontName) ? t.fontName[0] : t.fontName;
    return {
      id: t.id,
      frameId: t.parentFrameId || null,
      layerName: t.name,
      layerPath: t.path,
      originalText: t.characters,
      currentText: t.characters,
      nodeStatus: null,
      archived: false,
      fontFamily: fontName ? fontName.family : '',
      fontStyle: fontName ? fontName.style : ''
    };
  });

  let linkIndex = 0;
  if (linkedMode) {
    const textGroups = {};
    textNodes.forEach(n => {
      if (!textGroups[n.originalText]) textGroups[n.originalText] = [];
      textGroups[n.originalText].push(n.id);
    });

    const linkGroupMap = {};
    Object.entries(textGroups).forEach(([, ids]) => {
      if (ids.length > 1) {
        const groupId = 'link_' + linkIndex++;
        ids.forEach(id => { linkGroupMap[id] = groupId; });
      }
    });

    textNodes.forEach(n => { n.linkGroupId = linkGroupMap[n.id] || null; });
  } else {
    textNodes.forEach(n => { n.linkGroupId = null; });
  }

  figma.ui.postMessage({
    type: 'firebase-export',
    timestamp,
    figmaTimestamp,
    frames,
    textNodes,
    frameCount: frames.length,
    textCount: textNodes.length,
    linkGroupCount: linkIndex
  });
}

async function handleImport(data) {
  const allTextNodes = findTextNodes(figma.currentPage.children);
  const textNodeMap = new Map(allTextNodes.map(d => [d.id, d]));

  const updates = data.filter(item => {
    const nodeData = textNodeMap.get(item.id);
    return nodeData && item.newText !== undefined && item.newText.trim() !== nodeData.characters.trim();
  });

  if (updates.length === 0) {
    figma.ui.postMessage({ type: 'import-result', success: true, count: 0 });
    return;
  }

  const requiredFonts = new Set();
  for (const update of updates) {
    const nodeData = textNodeMap.get(update.id);
    if (nodeData && nodeData.fontName) {
      requiredFonts.add(JSON.stringify(nodeData.fontName));
    }
  }

  try {
    await Promise.all(
      Array.from(requiredFonts).map(f => figma.loadFontAsync(JSON.parse(f)))
    );
  } catch (e) {
    figma.ui.postMessage({ type: 'import-result', success: false, error: 'Failed to load a required font.' });
    return;
  }

  let updatedCount = 0;
  for (const update of updates) {
    const node = await figma.getNodeByIdAsync(update.id);
    if (node && node.type === 'TEXT') {
      try {
        node.characters = update.newText;
        updatedCount++;
      } catch (e) {
        console.warn('Failed to update node ' + update.id + ': ' + e);
      }
    }
  }

  figma.ui.postMessage({ type: 'import-result', success: true, count: updatedCount });
}

figma.showUI(__html__, { width: 400, height: 260 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export-text') {
    await handleExport(msg.linkedMode);
  } else if (msg.type === 'import-text') {
    await handleImport(msg.data);
  } else if (msg.type === 'resize') {
    figma.ui.resize(400, Math.max(200, Math.min(msg.height, 540)));
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};
