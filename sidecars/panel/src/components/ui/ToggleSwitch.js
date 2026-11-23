/**
 * @fileoverview Zero-ResizeObserver binary toggle switch (`ToggleSwitch.js`).
 * Uses a pure-CSS 2-column grid glider (`--seg-active-idx`) so Settings tabs do not
 * instantiate 10+ ResizeObservers or force synchronous layout measurements for simple
 * on/off or show/hide switches, while preserving `.segmented` / `.seg-btn` semantics.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import { i18nStore, t } from '../../i18n/index.js';

const TOGGLE_PRESET_DEFS = Object.freeze({
  enable: Object.freeze([
    { value: 'on', labelKey: 'settings.str.on' },
    { value: 'off', labelKey: 'settings.str.off' },
  ]),
  visibility: Object.freeze([
    { value: 'show', labelKey: 'settings.str.show' },
    { value: 'hide', labelKey: 'settings.str.hide' },
  ]),
  modernUi: Object.freeze([
    { value: 'on', labelKey: 'settings.gen.modernUiOn' },
    { value: 'off', labelKey: 'settings.gen.modernUiOff' },
  ]),
});

function resolveToggleOptions(props) {
  if (Array.isArray(props.options) && props.options.length === 2) {
    return props.options;
  }
  const defs = TOGGLE_PRESET_DEFS[props.preset] || TOGGLE_PRESET_DEFS.enable;
  return [
    { value: defs[0].value, label: t(defs[0].labelKey) },
    { value: defs[1].value, label: t(defs[1].labelKey) },
  ];
}

export const ToggleSwitch = defineComponent({
  name: 'ToggleSwitch',
  setup({ getProps, setProps, emit, onCleanup }) {
    const gliderEl = h('div', { className: 'seg-glider is-ready', 'aria-hidden': 'true' });
    const btns = [0, 1].map((slotIdx) =>
      h('button', {
        type: 'button',
        className: 'seg-btn',
        onClick: (e) => {
          e.stopPropagation();
          const opts = resolveToggleOptions(getProps());
          const opt = opts[slotIdx];
          if (opt) selectValue(opt.value);
        },
        onKeydown: (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const opts = resolveToggleOptions(getProps());
            const nextIdx = slotIdx === 0 ? 1 : 0;
            const targetOpt = opts[nextIdx];
            if (targetOpt) {
              selectValue(targetOpt.value);
              btns[nextIdx]?.focus?.();
            }
          }
        },
      })
    );

    const rootEl = h(
      'div',
      {
        className: 'segmented segmented--binary has-glider toggle-switch',
        role: 'group',
        'aria-label': getProps().ariaLabel || t('ui.seg.defaultAria'),
      },
      [gliderEl, btns[0], btns[1]]
    );

    function selectValue(nextVal) {
      if (getProps().modelValue !== nextVal) {
        setProps({ modelValue: nextVal });
        emit('update:modelValue', nextVal);
      }
    }

    function syncToggle() {
      const props = getProps();
      const opts = resolveToggleOptions(props);
      const aria = props.ariaLabelKey ? t(props.ariaLabelKey) : props.ariaLabel || t('ui.seg.defaultAria');
      patchAttr(rootEl, 'aria-label', aria);

      let activeIdx = 0;
      for (let i = 0; i < 2; i += 1) {
        const opt = opts[i];
        const btn = btns[i];
        const active = opt.value === props.modelValue;
        if (active) activeIdx = i;
        patchText(btn, opt.label);
        patchClasses(btn, { 'is-active': active });
        patchAttr(btn, 'aria-pressed', active ? 'true' : 'false');
        patchAttr(btn, 'data-seg-value', opt.value);
      }
      patchStyleVar(rootEl, '--seg-active-idx', String(activeIdx));
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncToggle();
      },
      { immediate: false }
    );
    onCleanup(unsubI18n);

    syncToggle();

    return {
      el: rootEl,
      onPropsChange: syncToggle,
      methods: {
        setValue(val) {
          setProps({ modelValue: val });
        },
        setOptions(options) {
          setProps({ options });
        },
        refreshGeometry() {},
      },
    };
  },
});
