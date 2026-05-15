(function () {
  const vscode = acquireVsCodeApi();

  let editor;
  let settings = {};
  let suppressChange = false;
  let updateTimer;
  let themeObserver;
  let themeStyleElement;
  let outlineObserver;
  let lastOutlineState;
  let tableCellClickBound = false;
  let tableHotkeyBound = false;
  let tableSelectionBound = false;
  let lastTableCell = null;
  const pendingImages = new Map();

  window.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.type) {
      case "init":
        settings = {
          vditorCdnUri: trimTrailingSlash(message.vditorCdnUri || ""),
          publicBaseUri: trimTrailingSlash(message.publicBaseUri || ""),
          documentDirUri: trimTrailingSlash(message.documentDirUri || ""),
          imageRoot: message.imageRoot || "/images",
          outlineEnabled: Boolean(message.outlineEnabled),
        };
        createEditor(message.text || "");
        break;

      case "setContent":
        if (editor && getMarkdownValue() !== message.text) {
          suppressChange = true;
          editor.setValue(message.text || "");
          queueImageResolution();
          suppressChange = false;
        }
        break;

      case "imageSaved":
        finishImageSave(message.requestId, message.link, message.alt);
        break;

      case "imageSaveFailed":
        failImageSave(message.requestId, message.message);
        break;

      case "tableAction":
        runTableAction(message.action);
        break;
    }
  });

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", postReady);
  } else {
    postReady();
  }

  function postReady() {
    vscode.postMessage({ type: "ready" });
  }

  function createEditor(initialValue) {
    if (editor) {
      return;
    }

    editor = new Vditor("editor", {
      mode: "wysiwyg",
      theme: getVditorTheme(),
      value: initialValue,
      height: "100%",
      lang: "zh_CN",
      outline: {
        enable: settings.outlineEnabled,
        position: "left",
      },
      preview: {
        maxWidth: 960,
      },
      cache: {
        enable: false,
      },
      cdn: settings.vditorCdnUri,
      input() {
        if (suppressChange) {
          return;
        }

        queueDocumentUpdate();
        queueImageResolution();
      },
      after() {
        applyEditorTheme();
        ensureToolbarIconFallback();
        applyOutlineState(settings.outlineEnabled);
        watchOutlineState();
        watchThemeChanges();
        watchTableCellClicks();
        watchTableSelection();
        watchTableHotkeys();
        queueImageResolution();
      },
      upload: {
        accept: "image/*",
        handler(files) {
          saveImages(files);
          return null;
        },
      },
    });
  }

  function watchThemeChanges() {
    if (themeObserver) {
      return;
    }

    themeObserver = new MutationObserver(applyEditorTheme);
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function applyEditorTheme() {
    injectThemePatch();
    ensureToolbarIconFallback();

    if (!editor || typeof editor.setTheme !== "function") {
      return;
    }

    editor.setTheme(getVditorTheme());
    window.setTimeout(() => {
      injectThemePatch();
      ensureToolbarIconFallback();
    }, 0);
  }

  function getVditorTheme() {
    if (document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast")) {
      return "dark";
    }

    return "classic";
  }

  function injectThemePatch() {
    if (!themeStyleElement) {
      themeStyleElement = document.createElement("style");
      themeStyleElement.id = "mutsumi-theme-patch";
      document.head.appendChild(themeStyleElement);
    }

    const isDark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
    const icon = isDark ? "#d4d4d4" : "#4b5563";
    const iconHover = isDark ? "#ffffff" : "#0969da";
    const editorBg = readCssVariable("--vscode-editor-background", isDark ? "#1e1e1e" : "#ffffff");
    const editorFg = readCssVariable("--vscode-editor-foreground", isDark ? "#d4d4d4" : "#24292f");
    const toolbarBg = readCssVariable("--vscode-editorGroupHeader-tabsBackground", editorBg);
    const border = readCssVariable("--vscode-panel-border", isDark ? "#3c3c3c" : "#d0d7de");

    themeStyleElement.textContent = `
      body .vditor {
        --border-color: ${border} !important;
        --toolbar-background-color: ${toolbarBg} !important;
        --toolbar-icon-color: ${icon} !important;
        --toolbar-icon-hover-color: ${iconHover} !important;
        --textarea-background-color: ${editorBg} !important;
        --textarea-text-color: ${editorFg} !important;
        background: ${editorBg} !important;
        color: ${editorFg} !important;
      }
      body .vditor-toolbar {
        background: ${toolbarBg} !important;
        border-bottom-color: ${border} !important;
      }
      body .vditor-toolbar__item .vditor-tooltipped,
      body .vditor-icon {
        color: ${icon} !important;
        opacity: 1 !important;
      }
      body .vditor-toolbar__item .vditor-tooltipped:hover,
      body .vditor-toolbar__item .vditor-tooltipped:focus,
      body .vditor-toolbar__item .vditor-tooltipped:active,
      body .vditor-icon:hover,
      body .vditor-icon--current,
      body .vditor-menu--current {
        color: ${iconHover} !important;
      }
      body .vditor-toolbar__item svg,
      body .vditor-toolbar__item svg *,
      body .vditor-toolbar__item svg use,
      body .vditor-toolbar__item svg path,
      body .vditor-icon svg,
      body .vditor-icon svg *,
      body .vditor-icon svg use,
      body .vditor-icon svg path {
        color: inherit !important;
        fill: currentColor !important;
        stroke: currentColor !important;
        opacity: 1 !important;
        visibility: visible !important;
      }
      body .vditor-content,
      body .vditor-wysiwyg,
      body .vditor-ir,
      body .vditor-sv,
      body .vditor-preview,
      body .vditor-reset,
      body .vditor-textarea {
        background: ${editorBg} !important;
        color: ${editorFg} !important;
      }
      body .vditor-wysiwyg > .vditor-panel--none {
        background: ${readCssVariable("--vscode-dropdown-background", readCssVariable("--vscode-editorWidget-background", editorBg))} !important;
        border-color: ${border} !important;
        color: ${icon} !important;
      }
    `;
  }

  function readCssVariable(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function ensureToolbarIconFallback() {
    const apply = () => {
      const hasVditorSymbols = Boolean(document.getElementById("vditor-icon-undo"));
      document.body.classList.toggle("mutsumi-icon-fallback", !hasVditorSymbols);
    };

    apply();
    window.setTimeout(apply, 100);
    window.setTimeout(apply, 500);
  }

  function watchTableCellClicks() {
    const editorRoot = getEditorRoot();
    if (tableCellClickBound || !editorRoot) {
      return;
    }

    tableCellClickBound = true;
    editorRoot.addEventListener("click", (event) => {
      const cell = event.target?.closest?.("td, th");
      if (!cell || !isTableCellInEditableArea(cell)) {
        return;
      }

      rememberTableCell(cell);
      focusTableCell(cell);
      window.setTimeout(() => showFallbackTablePopover(cell), 260);
    }, true);
  }

  function watchTableSelection() {
    const editorRoot = getEditorRoot();
    if (tableSelectionBound || !editorRoot) {
      return;
    }

    tableSelectionBound = true;

    editorRoot.addEventListener("mousedown", (event) => {
      const cell = event.target?.closest?.("td, th");
      if (cell && isTableCellInEditableArea(cell)) {
        rememberTableCell(cell);
      }
    }, true);

    editorRoot.addEventListener("focusin", (event) => {
      const cell = event.target?.closest?.("td, th");
      if (cell && isTableCellInEditableArea(cell)) {
        rememberTableCell(cell);
      }
    }, true);

    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection();
      const cell = selection && selection.rangeCount > 0 ? tableCellFromNode(selection.anchorNode) : null;
      if (cell) {
        rememberTableCell(cell);
      }
    });
  }

  function watchTableHotkeys() {
    const editorRoot = getEditorRoot();
    if (tableHotkeyBound || !editorRoot) {
      return;
    }

    tableHotkeyBound = true;
    editorRoot.addEventListener("keydown", (event) => {
      if (event.isComposing || event.altKey || event.target?.closest?.(".vditor-panel--none")) {
        return;
      }

      const eventCell = tableCellFromNode(event.target);
      const cell = eventCell ? rememberTableCell(eventCell) : getActiveTableCell();
      const action = cell ? tableHotkeyAction(event) : null;
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      action(cell);
    }, true);
  }

  function tableHotkeyAction(event) {
    if (!isPrimaryShortcut(event)) {
      return null;
    }

    if (event.shiftKey) {
      if (isKey(event, "f")) {
        return (cell) => insertTableRow(cell, "above");
      }
      if (isKey(event, "g")) {
        return (cell) => insertTableColumn(cell, "left");
      }
      if (isEqualKey(event)) {
        return (cell) => insertTableColumn(cell, "right");
      }
      if (isMinusKey(event)) {
        return deleteTableColumn;
      }
      if (isKey(event, "l")) {
        return (cell) => setTableColumnAlign(cell, "left");
      }
      if (isKey(event, "c")) {
        return (cell) => setTableColumnAlign(cell, "center");
      }
      if (isKey(event, "r")) {
        return (cell) => setTableColumnAlign(cell, "right");
      }
      return null;
    }

    if (isEqualKey(event)) {
      return (cell) => insertTableRow(cell, "below");
    }
    if (isMinusKey(event)) {
      return deleteTableRow;
    }

    return null;
  }

  function runTableAction(action) {
    const cell = getActiveTableCell();
    if (!cell) {
      return;
    }

    focusTableCell(cell);

    switch (action) {
      case "insertRowAbove":
        insertTableRow(cell, "above");
        return;
      case "insertRowBelow":
        insertTableRow(cell, "below");
        return;
      case "insertColumnLeft":
        insertTableColumn(cell, "left");
        return;
      case "insertColumnRight":
        insertTableColumn(cell, "right");
        return;
      case "deleteRow":
        deleteTableRow(cell);
        return;
      case "deleteColumn":
        deleteTableColumn(cell);
        return;
      case "alignLeft":
        setTableColumnAlign(cell, "left");
        return;
      case "alignCenter":
        setTableColumnAlign(cell, "center");
        return;
      case "alignRight":
        setTableColumnAlign(cell, "right");
        return;
    }
  }

  function getActiveTableCell() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const selectedCell = tableCellFromNode(selection.anchorNode);
      if (selectedCell) {
        return rememberTableCell(selectedCell);
      }
    }

    const focusedCell = tableCellFromNode(document.activeElement);
    if (focusedCell) {
      return rememberTableCell(focusedCell);
    }

    if (lastTableCell && lastTableCell.isConnected && isTableCellInEditableArea(lastTableCell)) {
      return lastTableCell;
    }

    return null;
  }

  function tableCellFromNode(node) {
    if (!node) {
      return null;
    }

    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const cell = element?.closest?.("td, th");
    if (cell && isTableCellInEditableArea(cell)) {
      return cell;
    }

    return null;
  }

  function getEditorRoot() {
    return editor?.vditor?.element || document.getElementById("editor");
  }

  function getEditableAreas() {
    return [
      editor?.vditor?.wysiwyg?.element,
      editor?.vditor?.ir?.element,
    ].filter(Boolean);
  }

  function getEditableAreaForNode(node) {
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!element) {
      return null;
    }

    return getEditableAreas().find((area) => area.contains(element)) || null;
  }

  function isTableCellInEditableArea(cell) {
    return Boolean(getEditableAreaForNode(cell));
  }

  function rememberTableCell(cell) {
    lastTableCell = cell;
    return cell;
  }

  function isPrimaryShortcut(event) {
    if (isMacPlatform()) {
      return event.metaKey && !event.ctrlKey;
    }

    return event.ctrlKey && !event.metaKey;
  }

  function isMacPlatform() {
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  }

  function isKey(event, key) {
    return event.key.toLowerCase() === key || event.code === `Key${key.toUpperCase()}`;
  }

  function isEqualKey(event) {
    return event.key === "=" || event.key === "+" || event.code === "Equal";
  }

  function isMinusKey(event) {
    return event.key === "-" || event.key === "_" || event.code === "Minus";
  }

  function focusTableCell(cell) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    rememberTableCell(cell);

    let targetNode = findTextNode(cell);
    if (!targetNode) {
      targetNode = document.createTextNode(" ");
      cell.appendChild(targetNode);
    } else if (targetNode.textContent.length === 0) {
      targetNode.textContent = " ";
    }

    const range = document.createRange();
    range.setStart(targetNode, targetNode.textContent.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function findTextNode(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      if (node.textContent.length > 0) {
        return node;
      }
      node = walker.nextNode();
    }

    return null;
  }

  function showFallbackTablePopover(cell) {
    if (!editor?.vditor?.wysiwyg?.popover || !editor?.vditor?.wysiwyg?.element || !cell.isConnected) {
      return;
    }

    const popover = editor.vditor.wysiwyg.popover;
    const hasTableControls = popover.querySelector('[data-type="insertRow"], [data-type="insertRowBelow"], [data-type="insertColumn"], [data-type="insertColumnRight"], [data-type="deleteRow"], [data-type="deleteColumn"]');
    if (popover.style.display === "block" && hasTableControls) {
      return;
    }

    const table = cell.closest("table");
    if (!table) {
      return;
    }

    popover.innerHTML = "";
    popover.classList.add("mutsumi-table-popover");

    [
      ["左对齐", "left", "vditor-icon-align-left", () => setTableColumnAlign(cell, "left")],
      ["居中", "center", "vditor-icon-align-center", () => setTableColumnAlign(cell, "center")],
      ["右对齐", "right", "vditor-icon-align-right", () => setTableColumnAlign(cell, "right")],
      ["上方插入行", "insertRowAbove", "vditor-icon-insert-rowb", () => insertTableRow(cell, "above")],
      ["下方插入行", "insertRowBelow", "vditor-icon-insert-row", () => insertTableRow(cell, "below")],
      ["左侧插入列", "insertColumnLeft", "vditor-icon-insert-columnb", () => insertTableColumn(cell, "left")],
      ["右侧插入列", "insertColumnRight", "vditor-icon-insert-column", () => insertTableColumn(cell, "right")],
      ["删除行", "deleteRow", "vditor-icon-delete-row", () => deleteTableRow(cell)],
      ["删除列", "deleteColumn", "vditor-icon-delete-column", () => deleteTableColumn(cell)],
    ].forEach(([label, type, icon, action]) => {
      popover.appendChild(createTableButton(label, type, icon, action));
    });

    positionTablePopover(popover, table);
  }

  function createTableButton(label, type, icon, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vditor-icon vditor-tooltipped vditor-tooltipped__n";
    button.dataset.type = type;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }

  function positionTablePopover(popover, table) {
    const editorElement = getEditableAreaForNode(table) || editor.vditor.wysiwyg.element;
    popover.style.left = "0";
    popover.style.display = "block";

    const top = Math.max(-8, table.offsetTop - 21 - editorElement.scrollTop);
    const left = Math.min(table.offsetLeft, editorElement.clientWidth - popover.clientWidth);

    popover.style.top = `${top}px`;
    popover.style.left = `${Math.max(0, left)}px`;
    popover.setAttribute("data-top", String(table.offsetTop - 21));
  }

  function insertTableRow(cell, position) {
    const row = cell.parentElement;
    const table = cell.closest("table");
    if (!row || !table) {
      return;
    }

    const newRow = document.createElement("tr");
    const useHeaderCells = row.parentElement?.tagName === "THEAD";

    Array.from(row.cells).forEach((sourceCell) => {
      const newCell = document.createElement(useHeaderCells ? "th" : "td");
      copyTableCellMeta(sourceCell, newCell);
      newCell.textContent = " ";
      newRow.appendChild(newCell);
    });

    if (position === "above") {
      row.insertAdjacentElement("beforebegin", newRow);
    } else {
      row.insertAdjacentElement("afterend", newRow);
    }

    finishTableMutation(newRow.cells[Math.min(cell.cellIndex, newRow.cells.length - 1)]);
  }

  function insertTableColumn(cell, position) {
    const table = cell.closest("table");
    if (!table) {
      return;
    }

    const index = cell.cellIndex;
    Array.from(table.rows).forEach((row) => {
      const referenceCell = row.cells[Math.min(index, row.cells.length - 1)];
      const newCell = document.createElement(row.parentElement?.tagName === "THEAD" ? "th" : "td");
      copyTableCellMeta(referenceCell, newCell);
      newCell.textContent = " ";

      if (position === "left") {
        referenceCell.insertAdjacentElement("beforebegin", newCell);
      } else {
        referenceCell.insertAdjacentElement("afterend", newCell);
      }
    });

    const nextIndex = position === "left" ? index : index + 1;
    const nextCell = cell.parentElement?.cells[Math.min(nextIndex, cell.parentElement.cells.length - 1)];
    finishTableMutation(nextCell || cell);
  }

  function deleteTableRow(cell) {
    const table = cell.closest("table");
    const row = cell.parentElement;
    if (!table || !row) {
      return;
    }

    const rowIndex = row.rowIndex;
    if (table.rows.length <= 1) {
      table.remove();
      lastTableCell = null;
      queueDocumentUpdate();
      return;
    }

    table.deleteRow(rowIndex);
    const nextRow = table.rows[Math.min(rowIndex, table.rows.length - 1)];
    finishTableMutation(nextRow?.cells[Math.min(cell.cellIndex, nextRow.cells.length - 1)]);
  }

  function deleteTableColumn(cell) {
    const table = cell.closest("table");
    if (!table) {
      return;
    }

    const index = cell.cellIndex;
    if (table.rows[0]?.cells.length <= 1) {
      table.remove();
      lastTableCell = null;
      queueDocumentUpdate();
      return;
    }

    Array.from(table.rows).forEach((row) => {
      row.cells[index]?.remove();
    });

    const nextCell = table.rows[Math.min(cell.parentElement.rowIndex, table.rows.length - 1)]
      ?.cells[Math.min(index, table.rows[0].cells.length - 1)];
    finishTableMutation(nextCell);
  }

  function setTableColumnAlign(cell, align) {
    const table = cell.closest("table");
    if (!table) {
      return;
    }

    Array.from(table.rows).forEach((row) => {
      row.cells[cell.cellIndex]?.setAttribute("align", align);
    });
    finishTableMutation(cell);
  }

  function copyTableCellMeta(sourceCell, targetCell) {
    const align = sourceCell?.getAttribute("align");
    if (align) {
      targetCell.setAttribute("align", align);
    }
  }

  function finishTableMutation(cell) {
    if (cell) {
      rememberTableCell(cell);
      focusTableCell(cell);
      showFallbackTablePopover(cell);
    }
    queueDocumentUpdate();
  }

  function applyOutlineState(enabled) {
    if (!editor || !editor.vditor || !editor.vditor.outline) {
      return;
    }

    editor.vditor.options.outline.enable = Boolean(enabled);
    editor.vditor.outline.toggle(editor.vditor, Boolean(enabled), false);
    rememberOutlineState(Boolean(enabled), false);
  }

  function watchOutlineState() {
    if (outlineObserver || !editor || !editor.vditor) {
      return;
    }

    const notify = () => {
      window.setTimeout(() => rememberOutlineState(readOutlineState(), true), 0);
    };
    const outlineButton = editor.vditor.toolbar.elements.outline?.firstElementChild;
    outlineButton?.addEventListener("click", notify);

    outlineObserver = new MutationObserver(notify);
    if (editor.vditor.outline?.element) {
      outlineObserver.observe(editor.vditor.outline.element, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
    if (outlineButton) {
      outlineObserver.observe(outlineButton, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    rememberOutlineState(readOutlineState(), false);
  }

  function readOutlineState() {
    if (!editor || !editor.vditor || !editor.vditor.outline) {
      return false;
    }

    return editor.vditor.outline.element.style.display !== "none" && Boolean(editor.vditor.options.outline.enable);
  }

  function rememberOutlineState(enabled, notifyExtension) {
    if (lastOutlineState === enabled) {
      return;
    }

    lastOutlineState = enabled;
    if (notifyExtension) {
      vscode.postMessage({
        type: "outlineState",
        enabled,
      });
    }
  }

  function saveImages(files) {
    Array.from(files || [])
      .filter((file) => file && file.type && file.type.startsWith("image/"))
      .forEach((file) => {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pendingImages.set(requestId, file);

        const reader = new FileReader();
        reader.onload = () => {
          vscode.postMessage({
            type: "saveImage",
            requestId,
            name: file.name,
            mime: file.type,
            dataUrl: String(reader.result || ""),
          });
        };
        reader.onerror = () => {
          pendingImages.delete(requestId);
        };
        reader.readAsDataURL(file);
      });
  }

  function finishImageSave(requestId, link, alt) {
    const file = pendingImages.get(requestId);
    pendingImages.delete(requestId);

    const text = `![${escapeMarkdownText(alt || (file && file.name) || "image")}](${link})\n`;
    editor.insertMD(text);
    queueDocumentUpdate();
    queueImageResolution();
  }

  function failImageSave(requestId, message) {
    pendingImages.delete(requestId);
    console.error(message || "Failed to save image.");
  }

  function queueDocumentUpdate() {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(() => {
      vscode.postMessage({
        type: "update",
        text: getMarkdownValue(),
      });
    }, 250);
  }

  function getMarkdownValue() {
    if (!editor) {
      return "";
    }

    return normalizeMarkdownLinks(withOriginalImageSources(() => editor.getValue()));
  }

  function withOriginalImageSources(callback) {
    const changed = [];

    document.querySelectorAll("#editor img[data-mutsumi-original-src]").forEach((img) => {
      changed.push([img, img.getAttribute("src") || ""]);
      img.setAttribute("src", img.getAttribute("data-mutsumi-original-src") || "");
    });

    try {
      return callback();
    } finally {
      changed.forEach(([img, src]) => {
        img.setAttribute("src", src);
      });
    }
  }

  function queueImageResolution() {
    window.requestAnimationFrame(resolveImages);
  }

  function resolveImages() {
    document.querySelectorAll("#editor img").forEach((img) => {
      const originalSrc = img.getAttribute("data-mutsumi-original-src") || img.getAttribute("src") || "";
      const resolvedSrc = resolveImageSource(originalSrc);

      if (resolvedSrc && resolvedSrc !== originalSrc) {
        img.setAttribute("data-mutsumi-original-src", originalSrc);
        img.setAttribute("src", resolvedSrc);
      }
    });
  }

  function resolveImageSource(src) {
    if (!src || isExternalOrSpecialUri(src)) {
      return src;
    }

    const imageRoot = settings.imageRoot.replace(/\/+$/g, "");
    if (settings.publicBaseUri && src.startsWith(`${imageRoot}/`)) {
      return `${settings.publicBaseUri}${src}`;
    }

    if (settings.publicBaseUri && src.startsWith(`${imageRoot.slice(1)}/`)) {
      return `${settings.publicBaseUri}/${src}`;
    }

    if (settings.documentDirUri && !src.startsWith("/")) {
      return `${settings.documentDirUri}/${src.replace(/^\.?\//, "")}`;
    }

    return src;
  }

  function normalizeMarkdownLinks(value) {
    let next = value;

    if (settings.publicBaseUri) {
      const escapedBase = escapeRegExp(settings.publicBaseUri);
      next = next.replace(new RegExp(`${escapedBase}/?`, "g"), "/");
    }

    if (settings.documentDirUri) {
      const escapedDocumentDir = escapeRegExp(settings.documentDirUri);
      next = next.replace(new RegExp(`${escapedDocumentDir}/?`, "g"), "");
    }

    return next;
  }

  function isExternalOrSpecialUri(src) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
  }

  function trimTrailingSlash(value) {
    return value.replace(/\/+$/g, "");
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeMarkdownText(value) {
    return String(value).replace(/[[\]\\]/g, "\\$&");
  }
})();
