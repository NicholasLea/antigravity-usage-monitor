/**
 * @fileoverview Reusable Drag-Sortable & `+` / `-` / `↑` / `↓` Dynamic Slot List (`EditableSlotList.js`).
 * Powers Topbar Capsule Slots (1..5), Hover Popup Modules (0..4),
 * Live Overview Modules (1..4), First-Row Metrics (1..4), and Step Table Columns (2..12).
 * Supports smooth pointer-based drag reordering with live preview callbacks (`onPreview`)
 * and single-commit persistence on drop (`onChange`).
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { CustomSelect } from '../ui/CustomSelect.js';

function isNodeWithin(target, container) {
  let cur = target;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parentNode || cur.host || null;
  }
  return false;
}

function findScrollableAncestor(el) {
  let cur = el?.parentNode || null;
  while (cur) {
    if (
      typeof cur.scrollHeight === 'number' &&
      typeof cur.clientHeight === 'number' &&
      cur.scrollHeight > cur.clientHeight + 4
    ) {
      return cur;
    }
    cur = cur.parentNode || null;
  }
  return null;
}

function applyRubberBand(value, minVal, maxVal, maxOvershoot = 24, factor = 0.25) {
  if (value < minVal) {
    const excess = minVal - value;
    return minVal - Math.min(maxOvershoot, excess * factor);
  }
  if (value > maxVal) {
    const excess = value - maxVal;
    return maxVal + Math.min(maxOvershoot, excess * factor);
  }
  return value;
}

function buildReorderedItems(sourceItems, fromIdx, toIdx) {
  const next = [...sourceItems];
  if (fromIdx === toIdx) return next;
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

function areSlotListsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const EditableSlotList = defineComponent({
  name: 'EditableSlotList',
  setup({ props, onCleanup }) {
    const minItems = Math.max(0, Number(props.minItems ?? 1));
    const maxItems = Math.max(minItems, Number(props.maxItems ?? 5));
    let currentItems = Array.isArray(props.items) ? [...props.items] : [];
    let currentOptions = Array.isArray(props.options) ? [...props.options] : [];
    let emptyHintText = String(props.emptyHintText || '');
    let addBtnTextFn = typeof props.addBtnTextFn === 'function' ? props.addBtnTextFn : null;
    let activeDrag = null;
    let settleCleanupTimer = null;
    let settlingRowEl = null;
    let suppressClickTimer = null;
    let suppressNextClick = false;
    let pendingSyncAfterDrag = false;

    const listEl = h('div', { className: 'editable-slot-list' });
    const emptyEl = h('div', {
      className: 'editable-slot-empty',
      hidden: true,
      text: emptyHintText,
    });

    const addBtnLabel = h('span', { text: '' });
    const addBtn = h(
      'button',
      {
        type: 'button',
        className: 'slot-add-btn',
        onClick: () => {
          if (currentItems.length >= maxItems) return;
          const usedSet = new Set(currentItems);
          const nextOpt = currentOptions.find((opt) => !usedSet.has(opt.value));
          if (!nextOpt) return;
          emitChange([...currentItems, nextOpt.value]);
        },
      },
      [createSvgIcon('plus', { size: 11 }), addBtnLabel]
    );

    const footerEl = h('div', { className: 'editable-slot-footer' }, [addBtn]);
    const rootEl = h('div', { className: 'editable-slot-wrap' }, [emptyEl, listEl, footerEl]);

    const rowPool = [];

    function clearSettleAnimation() {
      if (settleCleanupTimer) {
        clearTimeout(settleCleanupTimer);
        settleCleanupTimer = null;
      }
      if (settlingRowEl) {
        patchClasses(settlingRowEl, { 'is-settling': false });
        if (settlingRowEl.style) {
          settlingRowEl.style.transition = '';
          settlingRowEl.style.transform = '';
        }
        settlingRowEl = null;
      }
    }

    function clearClickSuppression() {
      if (suppressClickTimer) {
        clearTimeout(suppressClickTimer);
        suppressClickTimer = null;
      }
      suppressNextClick = false;
    }

    function armClickSuppression() {
      clearClickSuppression();
      suppressNextClick = true;
      suppressClickTimer = setTimeout(() => {
        suppressClickTimer = null;
        suppressNextClick = false;
      }, 120);
    }

    function emitChange(nextItems) {
      currentItems = [...nextItems];
      syncRows();
      if (typeof props.onPreview === 'function') {
        props.onPreview([...currentItems]);
      }
      if (typeof props.onChange === 'function') {
        props.onChange([...currentItems]);
      }
    }

    function resetRowDragStyles() {
      for (const r of rowPool) {
        patchClasses(r.rowEl, {
          'is-dragging': false,
          'is-drag-sibling': false,
        });
        if (r.rowEl?.style) {
          r.rowEl.style.transition = '';
          r.rowEl.style.transform = '';
        }
      }
    }

    function triggerDropSettleAnimation(targetRowEl, residualX, residualY) {
      if (!targetRowEl || !targetRowEl.style) return;
      if (Math.abs(residualX) < 0.5 && Math.abs(residualY) < 0.5) return;
      if (typeof requestAnimationFrame !== 'function') return;
      clearSettleAnimation();
      settlingRowEl = targetRowEl;
      targetRowEl.style.transition = 'none';
      targetRowEl.style.transform = `translate3d(${residualX.toFixed(2)}px, ${residualY.toFixed(2)}px, 0) scale(1.015)`;
      patchClasses(targetRowEl, { 'is-settling': true });
      // Commit initial pre-settle frame before animating into slot
      void targetRowEl.offsetHeight;
      requestAnimationFrame(() => {
        if (settlingRowEl !== targetRowEl) return;
        targetRowEl.style.transition = '';
        targetRowEl.style.transform = 'translate3d(0px, 0px, 0)';
      });
      settleCleanupTimer = setTimeout(() => {
        if (settlingRowEl === targetRowEl) {
          clearSettleAnimation();
        }
      }, 220);
    }

    function teardownActiveDrag({ revert = false } = {}) {
      if (!activeDrag) return;
      const { startItems, hasMoved, cleanupListeners, stopAutoScroll } = activeDrag;
      activeDrag = null;
      stopAutoScroll?.();
      cleanupListeners();
      patchClasses(listEl, { 'is-dragging-list': false });
      resetRowDragStyles();
      if (revert && hasMoved && !areSlotListsEqual(startItems, currentItems)) {
        currentItems = [...startItems];
        pendingSyncAfterDrag = false;
        syncRows();
        if (typeof props.onPreview === 'function') {
          props.onPreview([...currentItems]);
        }
      } else if (pendingSyncAfterDrag) {
        pendingSyncAfterDrag = false;
        syncRows();
      }
    }

    function startPointerDrag(e, initialRowIdx, { threshold = 3 } = {}) {
      if (e && e.button != null && e.button !== 0) return;
      if (currentItems.length <= 1) return;
      if (activeDrag) {
        teardownActiveDrag({ revert: false });
      }
      clearSettleAnimation();

      const startX = Number(e?.clientX ?? 0);
      const startY = Number(e?.clientY ?? 0);
      const startItems = [...currentItems];
      const count = startItems.length;
      const startIdx = initialRowIdx;
      let targetIdx = startIdx;
      let hasMoved = false;
      let slotMetrics = [];
      let rowGap = 5;
      let shiftDistance = 33;
      let startListTop = 0;
      let hasListRect = false;
      let lastClientX = startX;
      let lastClientY = startY;
      let lastDragOffsetX = 0;
      let lastDragOffsetY = 0;
      let scrollContainer = null;
      let autoScrollRaf = null;

      function stopAutoScroll() {
        if (autoScrollRaf != null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(autoScrollRaf);
        }
        autoScrollRaf = null;
      }

      function captureInitialGeometry() {
        slotMetrics = [];
        for (let i = 0; i < count; i += 1) {
          const rect = rowPool[i]?.rowEl?.getBoundingClientRect?.();
          const hasRect = Boolean(rect && Number.isFinite(rect.height) && rect.height > 0);
          const height = hasRect ? rect.height : 28;
          const top = hasRect ? rect.top : i * 33;
          slotMetrics.push({ top, height, centerY: top + height * 0.5 });
        }
        if (count >= 2) {
          const measuredGap = slotMetrics[1].top - (slotMetrics[0].top + slotMetrics[0].height);
          rowGap = Number.isFinite(measuredGap) && measuredGap >= 0 ? measuredGap : 5;
        } else {
          rowGap = 5;
        }
        shiftDistance = (slotMetrics[startIdx]?.height || 28) + rowGap;
        const listRect = listEl?.getBoundingClientRect?.();
        if (listRect && Number.isFinite(listRect.height) && listRect.height > 0) {
          startListTop = listRect.top;
          hasListRect = true;
        } else {
          startListTop = 0;
          hasListRect = false;
        }
        scrollContainer = findScrollableAncestor(listEl);
      }

      function computeListShiftY() {
        if (!hasListRect) return 0;
        const listRect = listEl?.getBoundingClientRect?.();
        if (listRect && Number.isFinite(listRect.top) && listRect.height > 0) {
          return listRect.top - startListTop;
        }
        return 0;
      }

      function updateSiblingPositionsAndBadges() {
        for (let i = 0; i < count; i += 1) {
          const entry = rowPool[i];
          if (!entry) continue;
          if (i === startIdx) {
            patchText(entry.indexBadge, String(targetIdx + 1));
            continue;
          }
          let visualSlot = i;
          let shiftY = 0;
          if (targetIdx > startIdx && i > startIdx && i <= targetIdx) {
            visualSlot = i - 1;
            shiftY = -shiftDistance;
          } else if (targetIdx < startIdx && i >= targetIdx && i < startIdx) {
            visualSlot = i + 1;
            shiftY = shiftDistance;
          }
          patchText(entry.indexBadge, String(visualSlot + 1));
          if (entry.rowEl?.style) {
            entry.rowEl.style.transform =
              shiftY !== 0 ? `translate3d(0px, ${shiftY.toFixed(2)}px, 0)` : 'translate3d(0px, 0px, 0)';
          }
        }
      }

      function updateDragFrame(clientX, clientY) {
        if (!activeDrag || !hasMoved) return;
        const listShiftY = computeListShiftY();
        const rawDeltaY = clientY - startY - listShiftY;
        const rawDeltaX = clientX - startX;

        const minDeltaY = slotMetrics[0].top - slotMetrics[startIdx].top;
        const maxDeltaY = slotMetrics[count - 1].top - slotMetrics[startIdx].top;
        const clampedY = applyRubberBand(rawDeltaY, minDeltaY, maxDeltaY, 26, 0.25);
        const clampedX =
          rawDeltaX === 0
            ? 0
            : Math.sign(rawDeltaX) * Math.min(18, Math.abs(rawDeltaX) * 0.22);

        lastDragOffsetX = clampedX;
        lastDragOffsetY = clampedY;

        const draggedEntry = rowPool[startIdx];
        if (draggedEntry?.rowEl?.style) {
          draggedEntry.rowEl.style.transform = `translate3d(${clampedX.toFixed(2)}px, ${clampedY.toFixed(2)}px, 0) scale(1.015)`;
        }

        // Static-slot center hit testing prevents any oscillation while siblings animate
        const draggedCenterY = slotMetrics[startIdx].centerY + rawDeltaY;
        let nextTarget = startIdx;
        if (rawDeltaY < 0) {
          for (let i = 0; i < startIdx; i += 1) {
            if (draggedCenterY < slotMetrics[i].centerY) {
              nextTarget = i;
              break;
            }
          }
        } else if (rawDeltaY > 0) {
          for (let i = count - 1; i > startIdx; i -= 1) {
            if (draggedCenterY > slotMetrics[i].centerY) {
              nextTarget = i;
              break;
            }
          }
        }

        if (nextTarget !== targetIdx) {
          targetIdx = nextTarget;
          activeDrag.dragIdx = targetIdx;
          currentItems = buildReorderedItems(startItems, startIdx, targetIdx);
          updateSiblingPositionsAndBadges();
          if (typeof props.onPreview === 'function') {
            props.onPreview([...currentItems]);
          }
        }
      }

      function tickAutoScroll() {
        autoScrollRaf = null;
        if (!activeDrag || !hasMoved || !scrollContainer) return;
        const containerRect = scrollContainer.getBoundingClientRect?.();
        if (!containerRect || containerRect.height <= 0) return;
        const edgeZone = 34;
        let step = 0;
        if (lastClientY < containerRect.top + edgeZone) {
          const ratio = Math.min(1, (containerRect.top + edgeZone - lastClientY) / edgeZone);
          step = -Math.ceil(3 + ratio * 7);
        } else if (lastClientY > containerRect.bottom - edgeZone) {
          const ratio = Math.min(1, (lastClientY - (containerRect.bottom - edgeZone)) / edgeZone);
          step = Math.ceil(3 + ratio * 7);
        }
        if (step !== 0) {
          const prevScroll = scrollContainer.scrollTop;
          scrollContainer.scrollTop = prevScroll + step;
          if (scrollContainer.scrollTop !== prevScroll) {
            updateDragFrame(lastClientX, lastClientY);
            if (typeof requestAnimationFrame === 'function') {
              autoScrollRaf = requestAnimationFrame(tickAutoScroll);
            }
          }
        }
      }

      function scheduleAutoScrollCheck() {
        if (!scrollContainer || autoScrollRaf != null || typeof requestAnimationFrame !== 'function') {
          return;
        }
        const containerRect = scrollContainer.getBoundingClientRect?.();
        if (!containerRect || containerRect.height <= 0) return;
        if (lastClientY < containerRect.top + 34 || lastClientY > containerRect.bottom - 34) {
          autoScrollRaf = requestAnimationFrame(tickAutoScroll);
        }
      }

      const onPointerMove = (ev) => {
        if (!activeDrag) return;
        const clientX = Number(ev?.clientX ?? startX);
        const clientY = Number(ev?.clientY ?? startY);
        lastClientX = clientX;
        lastClientY = clientY;

        if (!hasMoved) {
          const dist = Math.hypot(clientX - startX, clientY - startY);
          if (dist < threshold) return;
          hasMoved = true;
          activeDrag.hasMoved = true;
          captureInitialGeometry();
          for (let k = 0; k < count; k += 1) {
            rowPool[k]?.selectComp?.close?.();
          }
          patchClasses(listEl, { 'is-dragging-list': true });
          for (let k = 0; k < count; k += 1) {
            if (!rowPool[k]) continue;
            if (k === startIdx) {
              patchClasses(rowPool[k].rowEl, { 'is-dragging': true, 'is-drag-sibling': false });
            } else {
              patchClasses(rowPool[k].rowEl, { 'is-dragging': false, 'is-drag-sibling': true });
            }
          }
          updateSiblingPositionsAndBadges();
        }
        ev?.preventDefault?.();
        updateDragFrame(clientX, clientY);
        scheduleAutoScrollCheck();
      };

      const onPointerUp = () => {
        if (!activeDrag) return;
        const moved = activeDrag.hasMoved;
        const finalTargetIdx = targetIdx;
        const targetSlotOffsetY =
          moved && slotMetrics[finalTargetIdx] && slotMetrics[startIdx]
            ? slotMetrics[finalTargetIdx].top - slotMetrics[startIdx].top
            : 0;
        const residualX = moved ? lastDragOffsetX : 0;
        const residualY = moved ? lastDragOffsetY - targetSlotOffsetY : 0;
        const changed = !areSlotListsEqual(startItems, currentItems);

        teardownActiveDrag({ revert: false });
        if (moved) {
          armClickSuppression();
        }
        if (moved && changed) {
          emitChange([...currentItems]);
        } else if (moved) {
          syncRows();
        }
        if (moved && rowPool[finalTargetIdx]?.rowEl) {
          triggerDropSettleAnimation(rowPool[finalTargetIdx].rowEl, residualX, residualY);
        }
      };

      const onPointerCancel = () => {
        teardownActiveDrag({ revert: true });
      };

      const onKeyDown = (ev) => {
        if (ev?.key === 'Escape') {
          teardownActiveDrag({ revert: true });
        }
      };

      const docTarget =
        typeof document !== 'undefined' && typeof document.addEventListener === 'function'
          ? document
          : null;
      const winTarget =
        typeof window !== 'undefined' && typeof window.addEventListener === 'function'
          ? window
          : null;

      if (docTarget) {
        docTarget.addEventListener('pointermove', onPointerMove);
        docTarget.addEventListener('pointerup', onPointerUp);
        docTarget.addEventListener('pointercancel', onPointerCancel);
        docTarget.addEventListener('keydown', onKeyDown);
      }
      if (winTarget) {
        winTarget.addEventListener('blur', onPointerCancel);
      }

      activeDrag = {
        startItems,
        dragIdx: startIdx,
        hasMoved: false,
        stopAutoScroll,
        cleanupListeners: () => {
          if (docTarget && typeof docTarget.removeEventListener === 'function') {
            docTarget.removeEventListener('pointermove', onPointerMove);
            docTarget.removeEventListener('pointerup', onPointerUp);
            docTarget.removeEventListener('pointercancel', onPointerCancel);
            docTarget.removeEventListener('keydown', onKeyDown);
          }
          if (winTarget && typeof winTarget.removeEventListener === 'function') {
            winTarget.removeEventListener('blur', onPointerCancel);
          }
        },
      };
    }

    function createSlotRow() {
      let rowIndex = 0;
      const dragHandle = h(
        'span',
        {
          className: 'slot-drag-handle',
          'aria-hidden': 'true',
          onPointerdown: (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            startPointerDrag(e, rowIndex);
          },
        },
        [createSvgIcon('grip', { size: 12 })]
      );
      const indexBadge = h('span', { className: 'slot-index-badge text-mono', text: '1' });
      const selectComp = CustomSelect({
        modelValue: '',
        options: [],
        onUpdateModelValue: (nextVal) => {
          if (!nextVal || currentItems[rowIndex] === nextVal) return;
          if (currentItems.some((v, idx) => idx !== rowIndex && v === nextVal)) return;
          const next = [...currentItems];
          next[rowIndex] = nextVal;
          emitChange(next);
        },
      });

      const upBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex <= 0) return;
            const next = [...currentItems];
            const tmp = next[rowIndex - 1];
            next[rowIndex - 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-up', { size: 12 })]
      );

      const downBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex >= currentItems.length - 1) return;
            const next = [...currentItems];
            const tmp = next[rowIndex + 1];
            next[rowIndex + 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-down', { size: 12 })]
      );

      const removeBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn slot-remove-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (currentItems.length <= minItems) return;
            const next = currentItems.filter((_, idx) => idx !== rowIndex);
            emitChange(next);
          },
        },
        [createSvgIcon('minus', { size: 12 })]
      );

      const selectMenuEl = selectComp.el?.querySelector?.('.select-menu') || null;
      const orderBtnsEl = h('span', { className: 'slot-order-btns' }, [upBtn, downBtn, removeBtn]);

      const rowEl = h(
        'div',
        {
          className: 'editable-slot-row',
          onPointerdown: (e) => {
            if (isNodeWithin(e?.target, orderBtnsEl)) return;
            if (selectMenuEl && isNodeWithin(e?.target, selectMenuEl)) return;
            const onSelectTrigger = isNodeWithin(e?.target, selectComp.el);
            startPointerDrag(e, rowIndex, { threshold: onSelectTrigger ? 5 : 3 });
          },
        },
        [dragHandle, indexBadge, selectComp.el, orderBtnsEl]
      );
      if (typeof rowEl.addEventListener === 'function') {
        rowEl.addEventListener(
          'click',
          (e) => {
            if (!suppressNextClick) return;
            clearClickSuppression();
            e.preventDefault?.();
            e.stopPropagation?.();
          },
          true
        );
      }

      return {
        rowEl,
        dragHandle,
        indexBadge,
        selectComp,
        upBtn,
        downBtn,
        removeBtn,
        setIndex(idx) {
          rowIndex = idx;
        },
      };
    }

    function syncRows() {
      const count = currentItems.length;
      patchAttr(emptyEl, 'hidden', count > 0 || !emptyHintText);
      if (emptyHintText) {
        patchText(emptyEl, emptyHintText);
      }
      patchAttr(listEl, 'hidden', count === 0);

      while (rowPool.length < count) {
        rowPool.push(createSlotRow());
      }

      while (listEl.children && listEl.children.length > count) {
        const tailIdx = listEl.children.length - 1;
        const tailChild = listEl.children[tailIdx];
        tailChild?.remove?.();
      }

      const canDrag = count > 1;
      const dragTitle = canDrag ? t('settings.slot.dragHint') : '';
      const canRemove = count > minItems;
      const removeTitle = canRemove
        ? t('settings.slot.remove')
        : t('settings.slot.minReached', { min: minItems });

      for (let i = 0; i < count; i += 1) {
        const entry = rowPool[i];
        const itemVal = currentItems[i];
        entry.setIndex(i);
        patchAttr(entry.rowEl, 'data-slot-row', String(i));
        patchText(entry.indexBadge, String(i + 1));
        patchClasses(entry.dragHandle, { 'is-disabled': !canDrag });
        patchAttr(entry.dragHandle, 'title', dragTitle || null);

        const otherUsed = new Set(currentItems.filter((_, idx) => idx !== i));
        const rowOpts = currentOptions.map((opt) => {
          const isTaken = otherUsed.has(opt.value);
          return isTaken
            ? {
                ...opt,
                disabled: true,
                meta: t('settings.slot.alreadyAdded'),
              }
            : opt;
        });

        entry.selectComp.setProps({
          modelValue: itemVal,
          options: rowOpts,
        });

        patchAttr(entry.upBtn, 'disabled', i === 0);
        patchAttr(entry.upBtn, 'title', t('settings.slot.moveUp'));
        patchAttr(entry.upBtn, 'aria-label', t('settings.slot.moveUp'));

        patchAttr(entry.downBtn, 'disabled', i === count - 1);
        patchAttr(entry.downBtn, 'title', t('settings.slot.moveDown'));
        patchAttr(entry.downBtn, 'aria-label', t('settings.slot.moveDown'));

        patchAttr(entry.removeBtn, 'disabled', !canRemove);
        patchAttr(entry.removeBtn, 'title', removeTitle);
        patchAttr(entry.removeBtn, 'aria-label', removeTitle);

        if (!listEl.children || listEl.children[i] !== entry.rowEl) {
          listEl.appendChild(entry.rowEl);
        }
      }

      // Close any hidden pooled selects
      for (let j = count; j < rowPool.length; j += 1) {
        rowPool[j].selectComp.close();
      }

      const usedAll = new Set(currentItems);
      const hasAvailableOption = currentOptions.some((opt) => !usedAll.has(opt.value));
      const disableAdd = count >= maxItems || !hasAvailableOption;
      patchAttr(addBtn, 'disabled', disableAdd);
      const addLabel = addBtnTextFn
        ? addBtnTextFn(count, maxItems)
        : `+ (${count}/${maxItems})`;
      patchText(addBtnLabel, addLabel);
    }

    function setProps(next = {}) {
      if (!activeDrag && Array.isArray(next.items)) {
        currentItems = [...next.items];
      }
      if (Array.isArray(next.options)) {
        currentOptions = [...next.options];
      }
      if (next.emptyHintText !== undefined) {
        emptyHintText = String(next.emptyHintText || '');
      }
      if (typeof next.addBtnTextFn === 'function') {
        addBtnTextFn = next.addBtnTextFn;
      }
      if (activeDrag) {
        pendingSyncAfterDrag = true;
        return;
      }
      syncRows();
    }

    syncRows();

    onCleanup(() => {
      teardownActiveDrag({ revert: false });
      clearSettleAnimation();
      clearClickSuppression();
      for (const entry of rowPool) {
        entry.selectComp.destroy();
      }
      rowPool.length = 0;
    });

    return {
      el: rootEl,
      refs: {
        listEl,
        addBtn,
        emptyEl,
        setProps,
        getItems: () => [...currentItems],
        getSelects: () => rowPool.slice(0, currentItems.length).map((r) => r.selectComp),
      },
    };
  },
});
