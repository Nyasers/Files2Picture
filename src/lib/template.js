// ══════════════════════════════════════════════
// 模板接口 — 统一访问 <templates> 仓库
//   设计参考 l4t static/utils/template.js
//   - TemplateMap 收集所有 <template> 并缓存 content
//   - loadTemplate(id, fields) 克隆 + data-field 注入
// ══════════════════════════════════════════════
"use strict";

class TemplateMap {
  /** @type {Map<string, DocumentFragment>} */
  #map = new Map();

  /**
   * @param {Document | Element} [root=document]
   */
  constructor(root) {
    (root || document.querySelector("templates") || document)
      .querySelectorAll("template")
      .forEach((tpl) => this.#map.set(tpl.id, tpl.content));
  }

  /**
   * @param {string} id
   * @returns {DocumentFragment | undefined}
   */
  get(id) {
    const content = this.#map.get(id);
    return content ? content.cloneNode(true) : undefined;
  }
}

// ── 缓存（惰性初始化，函数静态属性） ──

function getCache() {
  return (getCache.cache ??= new TemplateMap());
}

// ═══ 主要 API ═══

/**
 * 加载模板并注入内容
 * @param {string} id - 模板 id
 * @param {Object} [fields] - { "fieldName": { attr: value, ... } }
 *   支持的特殊属性：content(textContent), dataset, event
 *   其余属性直接 setAttribute
 *   不传 fields 则纯克隆
 * @returns {DocumentFragment | undefined}
 */
export function loadTemplate(id, fields) {
  const frag = getCache().get(id);
  if (!frag) return;

  if (fields) {
    for (const [key, attrs] of Object.entries(fields)) {
      frag.querySelectorAll(`[data-field="${key}"]`).forEach((el) => {
        for (const [attr, value] of Object.entries(attrs)) {
          switch (attr) {
            case "content":
              el.textContent = value;
              break;
            case "dataset":
              Object.assign(el.dataset, value);
              break;
            case "event":
              for (const [evt, handler] of Object.entries(value))
                el.addEventListener(evt, handler);
              break;
            default:
              el.setAttribute(attr, value);
          }
        }
      });
    }
  }
  return frag;
}
