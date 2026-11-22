/**
 * @fileoverview 紧凑竖向三点 (`⋮`) 下拉单选操作菜单组件 (`ActionMenu.js`)。
 * 兼容 Shadow DOM (`composedPath`) 外部点击收起及 Escape 键盘关闭，供用量统计、调用明细等工具栏复用。
 */

import { defineComponent } from '../../core/component.js';
import { h, isEventInside, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';

export const ActionMenu = defineComponent({
  name: 'ActionMenu',
  setup({ props, onCleanup }) {
    let isOpen = false;
    let currentItems = Array.isArray(props?.items) ? props.items.slice() : [];
    const align = props?.align === 'left' ? 'left' : 'right';

    const triggerBtn = h(
      'button',
      {
        type: 'button',
        className: `action-menu-trigger${props?.buttonClassName ? ` ${props.buttonClassName}` : ''}`,
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'aria-label': props?.ariaLabel || 'More actions',
        title: props?.ariaLabel || 'More actions',
        onclick: (e) => {
          e?.stopPropagation?.();
          if (isOpen) {
            close();
          } else {
            open();
          }
        },
      },
      [createSvgIcon('more-vertical', { size: 13 })]
    );

    const menuEl = h('div', {
      className: `action-menu-popover${align === 'left' ? ' align-left' : ' align-right'}`,
      role: 'menu',
      hidden: true,
    });

    const rootEl = h(
      'div',
      {
        className: `action-menu${props?.className ? ` ${props.className}` : ''}`,
      },
      [triggerBtn, menuEl]
    );

    let itemBtns = [];

    function rebuildItems(items) {
      currentItems = Array.isArray(items) ? items.slice() : [];
      menuEl.textContent = '';
      itemBtns = currentItems.map((item) => {
        const iconNode = item.icon ? createSvgIcon(item.icon, { size: 12 }) : null;
        const labelNode = h('span', { className: 'action-menu-item-label', text: item.label || '' });
        const btn = h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'action-menu-item',
            'data-action-key': item.key || '',
            title: item.title || '',
            disabled: Boolean(item.disabled),
            onclick: (e) => {
              e?.stopPropagation?.();
              close();
              if (!item.disabled && typeof item.onSelect === 'function') {
                item.onSelect();
              }
            },
          },
          iconNode ? [iconNode, labelNode] : [labelNode]
        );
        menuEl.appendChild(btn);
        return { key: item.key, btn, labelNode };
      });
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      patchClasses(rootEl, { 'is-open': true });
      patchAttr(triggerBtn, 'aria-expanded', 'true');
      patchAttr(menuEl, 'hidden', false);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      patchClasses(rootEl, { 'is-open': false });
      patchAttr(triggerBtn, 'aria-expanded', 'false');
      patchAttr(menuEl, 'hidden', true);
    }

    function onDocPointerDown(e) {
      if (!isOpen) return;
      if (isEventInside(e, rootEl)) return;
      close();
    }

    function onDocKeyDown(e) {
      if (!isOpen) return;
      if (e?.key === 'Escape') {
        e.preventDefault?.();
        close();
        triggerBtn.focus?.();
      }
    }

    rebuildItems(currentItems);

    if (typeof document !== 'undefined') {
      document.addEventListener?.('pointerdown', onDocPointerDown, true);
      document.addEventListener?.('click', onDocPointerDown, true);
      document.addEventListener?.('keydown', onDocKeyDown, true);
    }

    onCleanup(() => {
      if (typeof document !== 'undefined') {
        document.removeEventListener?.('pointerdown', onDocPointerDown, true);
        document.removeEventListener?.('click', onDocPointerDown, true);
        document.removeEventListener?.('keydown', onDocKeyDown, true);
      }
    });

    return {
      el: rootEl,
      refs: {
        triggerBtn,
        menuEl,
        getItemBtn: (key) => itemBtns.find((it) => it.key === key)?.btn || null,
        isOpen: () => isOpen,
        open,
        close,
        setItems: (nextItems) => {
          rebuildItems(nextItems);
        },
        setAriaLabel: (label) => {
          patchAttr(triggerBtn, 'aria-label', label);
          patchAttr(triggerBtn, 'title', label);
        },
        setHidden: (hidden) => {
          if (hidden) close();
          patchAttr(rootEl, 'hidden', Boolean(hidden));
        },
        updateItemLabels: (labelMap) => {
          for (const it of itemBtns) {
            const entry = labelMap?.[it.key];
            if (!entry) continue;
            if (entry.label !== undefined) patchText(it.labelNode, entry.label);
            if (entry.title !== undefined) patchAttr(it.btn, 'title', entry.title);
          }
        },
      },
    };
  },
});
