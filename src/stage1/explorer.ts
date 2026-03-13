import type { Page } from '@playwright/test';
import type {
  Stage1FieldCandidate,
  Stage1StructuredSnapshot,
} from './types';

function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeLabel(input: string): string {
  return normalizeText(input).replace(/[*：:]/g, '');
}

function uniqueNonEmpty(values: string[]): string[] {
  const filtered = values
    .map((item) => normalizeText(item))
    .filter((item) => item.length > 0);
  return [...new Set(filtered)];
}

function uniqueFieldCandidates(candidates: Stage1FieldCandidate[]): Stage1FieldCandidate[] {
  const record = new Map<string, Stage1FieldCandidate>();
  candidates.forEach((item) => {
    const key = `${item.label}|${item.placeholder || ''}`;
    if (!record.has(key)) {
      record.set(key, item);
    }
  });
  return [...record.values()];
}

function uniqueRowSamples(rows: string[][]): string[][] {
  const record = new Map<string, string[]>();
  rows.forEach((row) => {
    const normalizedRow = uniqueNonEmpty(row).slice(0, 20);
    if (normalizedRow.length === 0) {
      return;
    }
    const key = normalizedRow.join('||');
    if (!record.has(key)) {
      record.set(key, normalizedRow);
    }
  });
  return [...record.values()];
}

/**
 * 通过页面可见 DOM 采集第一段结构化探索结果。
 * @author Jiane
 */
export async function collectStage1StructuredSnapshot(
  page: Page,
): Promise<Stage1StructuredSnapshot> {
  const currentUrl = page.url();
  const pageTitle = await page.title();

  const rawSnapshot = await page.evaluate(() => {
    function normalize(text: string): string {
      return text.replace(/\s+/g, ' ').trim();
    }

    function isVisible(element: Element): boolean {
      const node = element as HTMLElement;
      if (!node) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function collectTextsBySelectors(selectors: string[], limit: number): string[] {
      const result: string[] = [];
      selectors.forEach((selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        nodes.forEach((node) => {
          if (!isVisible(node)) {
            return;
          }
          const text = normalize(node.textContent || '');
          if (text.length > 0) {
            result.push(text);
          }
        });
      });
      return result.slice(0, limit);
    }

    function collectTableRowSamples(limitRows: number, limitCells: number): string[][] {
      const rowSelectors = [
        'table tbody tr',
        '.el-table__body tr',
        '.ant-table-tbody tr',
        '.ivu-table-body tr',
      ];
      const result: string[][] = [];
      const seen = new Set<string>();
      for (let i = 0; i < rowSelectors.length; i += 1) {
        const rows = Array.from(document.querySelectorAll(rowSelectors[i]));
        for (let j = 0; j < rows.length; j += 1) {
          if (result.length >= limitRows) {
            return result;
          }
          const row = rows[j];
          if (!isVisible(row)) {
            continue;
          }
          const cells = Array.from(
            row.querySelectorAll('td, .el-table__cell, .ant-table-cell, .ivu-table-cell'),
          );
          const cellTexts = cells
            .map((cell) => normalize(cell.textContent || ''))
            .filter((text) => text.length > 0)
            .slice(0, limitCells);
          if (cellTexts.length === 0) {
            const rowText = normalize(row.textContent || '');
            if (!rowText) {
              continue;
            }
            cellTexts.push(rowText);
          }
          const rowKey = cellTexts.join('||');
          if (seen.has(rowKey)) {
            continue;
          }
          seen.add(rowKey);
          result.push(cellTexts);
        }
      }
      return result;
    }

    function findFieldLabel(input: HTMLInputElement | HTMLTextAreaElement): string {
      const id = input.getAttribute('id');
      if (id) {
        const labelByFor = document.querySelector(`label[for="${id}"]`);
        if (labelByFor && isVisible(labelByFor)) {
          const text = normalize(labelByFor.textContent || '');
          if (text) {
            return text;
          }
        }
      }
      const formItem = input.closest('.el-form-item, .ant-form-item, .ivu-form-item, .form-item');
      if (formItem) {
        const labelNode = formItem.querySelector('label, .el-form-item__label, .ant-form-item-label, .ivu-form-item-label');
        if (labelNode && isVisible(labelNode)) {
          const text = normalize(labelNode.textContent || '');
          if (text) {
            return text;
          }
        }
      }
      const ariaLabel = normalize(input.getAttribute('aria-label') || '');
      if (ariaLabel) {
        return ariaLabel;
      }
      const placeholder = normalize(input.getAttribute('placeholder') || '');
      if (placeholder) {
        return placeholder;
      }
      return '';
    }

    const menuTexts = collectTextsBySelectors(
      [
        '[role="menuitem"]',
        '.el-menu-item',
        '.el-submenu__title',
        '.ant-menu-item',
        '.ant-menu-submenu-title',
        '.ivu-menu-item',
        '.ivu-menu-submenu-title',
        '.menu-item',
      ],
      200,
    );

    const buttonTexts = collectTextsBySelectors(
      [
        'button',
        '[role="button"]',
        '.el-button',
        '.ant-btn',
        '.ivu-btn',
      ],
      300,
    );

    const linkTexts = collectTextsBySelectors(
      [
        'a',
        '[role="link"]',
        '.el-link',
      ],
      300,
    );

    const formFieldCandidates: Array<{
      label: string;
      placeholder?: string;
      required?: boolean;
    }> = [];
    const dateFieldCandidates: string[] = [];
    const selectLikeFieldCandidates: string[] = [];
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    inputs.forEach((node) => {
      if (!isVisible(node)) {
        return;
      }
      const input = node as HTMLInputElement | HTMLTextAreaElement;
      const label = normalize(findFieldLabel(input));
      if (!label) {
        return;
      }
      const placeholder = normalize(input.getAttribute('placeholder') || '');
      const required = input.required || input.getAttribute('aria-required') === 'true' || /\*/.test(label);
      formFieldCandidates.push({
        label,
        placeholder: placeholder || undefined,
        required,
      });
      const fieldDisplay = normalize(label || placeholder || '');
      if (
        fieldDisplay
        && (
          /日期|时间|date|time/i.test(fieldDisplay)
          || /datepicker|timepicker/i.test(node.className || '')
        )
      ) {
        dateFieldCandidates.push(fieldDisplay);
      }
      if (
        fieldDisplay
        && (
          (input as HTMLInputElement).readOnly
          || /请选择|下拉|级联|城市|地区/.test(placeholder)
          || /select|cascader/i.test(node.className || '')
        )
      ) {
        selectLikeFieldCandidates.push(fieldDisplay);
      }
    });

    function collectOptionCandidates(
      selectorList: string[],
      fallbackInputSelector: string,
    ): string[] {
      const texts = collectTextsBySelectors(selectorList, 300);
      if (texts.length > 0) {
        return texts;
      }
      const result: string[] = [];
      const inputs = Array.from(document.querySelectorAll(fallbackInputSelector));
      inputs.forEach((item) => {
        if (!isVisible(item)) {
          return;
        }
        const candidate = normalize((item.closest('label')?.textContent || item.getAttribute('aria-label') || ''));
        if (candidate) {
          result.push(candidate);
        }
      });
      return result;
    }

    const radioCandidates = collectOptionCandidates(
      [
        '.el-radio',
        '.ant-radio-wrapper',
        '.ivu-radio-wrapper',
        '[role="radio"]',
      ],
      'input[type="radio"]',
    );

    const checkboxCandidates = collectOptionCandidates(
      [
        '.el-checkbox',
        '.ant-checkbox-wrapper',
        '.ivu-checkbox-wrapper',
        '[role="checkbox"]',
      ],
      'input[type="checkbox"]',
    );

    const tableColumns = collectTextsBySelectors(
      [
        'table th',
        '.el-table th .cell',
        '.ant-table-thead th',
        '.ivu-table-header th',
      ],
      200,
    );

    const dialogTitles = collectTextsBySelectors(
      [
        'div[role="dialog"] .el-dialog__title',
        '.el-dialog__header .el-dialog__title',
        '.ant-modal-title',
        '.ivu-modal-header-inner',
      ],
      100,
    );

    const rowActionButtons = collectTextsBySelectors(
      [
        'table tbody td button',
        'table tbody td a',
        '.el-table__body td button',
        '.el-table__body td a',
        '.ant-table-tbody td button',
        '.ant-table-tbody td a',
      ],
      200,
    );

    const toastTexts = collectTextsBySelectors(
      [
        '.el-message',
        '.el-notification',
        '.ant-message',
        '.ant-notification-notice',
        '.ivu-message',
        '.ivu-notice',
        '[role="alert"]',
      ],
      100,
    );

    const visibleTexts = collectTextsBySelectors(
      [
        'h1',
        'h2',
        'h3',
        'button',
        'label',
        'th',
        '.el-form-item__label',
        '.ant-form-item-label',
      ],
      400,
    );

    const tableRowSamples = collectTableRowSamples(12, 16);

    return {
      menuTexts,
      buttonTexts,
      linkTexts,
      formFieldCandidates,
      dateFieldCandidates,
      radioCandidates,
      checkboxCandidates,
      selectLikeFieldCandidates,
      tableColumns,
      tableRowSamples,
      dialogTitles,
      rowActionButtons,
      toastTexts,
      visibleTexts,
    };
  });

  const menuCandidates = uniqueNonEmpty(rawSnapshot.menuTexts || []);
  const buttonTexts = uniqueNonEmpty(rawSnapshot.buttonTexts || []);
  const linkCandidates = uniqueNonEmpty(rawSnapshot.linkTexts || []);
  const openButtonCandidates = buttonTexts.filter((item) => /(新增|添加|新建|创建)/.test(item));
  const submitButtonCandidates = buttonTexts.filter((item) => /(确定|提交|保存|确认)/.test(item));
  const closeButtonCandidates = buttonTexts.filter((item) => /(取消|关闭|返回)/.test(item));
  const searchTriggerCandidates = buttonTexts.filter((item) => /(搜索|查询)/.test(item));
  const resetButtonCandidates = buttonTexts.filter((item) => /(重置|清空)/.test(item));
  const dialogTitleCandidates = uniqueNonEmpty(rawSnapshot.dialogTitles || []);
  const rowActionButtonCandidates = uniqueNonEmpty(rawSnapshot.rowActionButtons || []);

  const formFieldCandidates = uniqueFieldCandidates(
    (rawSnapshot.formFieldCandidates || [])
      .map((item) => ({
        label: normalizeLabel(item.label || ''),
        placeholder: item.placeholder ? normalizeText(item.placeholder) : undefined,
        required: item.required === true,
      }))
      .filter((item) => item.label.length > 0),
  );

  const dateFieldCandidates = uniqueNonEmpty(rawSnapshot.dateFieldCandidates || []);
  const radioCandidates = uniqueNonEmpty(rawSnapshot.radioCandidates || []);
  const checkboxCandidates = uniqueNonEmpty(rawSnapshot.checkboxCandidates || []);
  const selectLikeFieldCandidates = uniqueNonEmpty(rawSnapshot.selectLikeFieldCandidates || []);

  const searchFieldCandidates = uniqueNonEmpty(
    formFieldCandidates
      .map((item) => item.label)
      .filter((item) => /(搜索|查询|关键字|名称|编号)/.test(item)),
  );

  const tableColumnCandidates = uniqueNonEmpty(rawSnapshot.tableColumns || []);
  const tableRowSamples = uniqueRowSamples(rawSnapshot.tableRowSamples || []).slice(0, 12);
  const successTextCandidates = uniqueNonEmpty(
    [
      ...(rawSnapshot.toastTexts || []),
      ...(rawSnapshot.visibleTexts || []).filter((item: string) => /(成功|已保存|提交成功|操作成功|删除成功)/.test(item)),
    ],
  );
  const visibleTexts = uniqueNonEmpty(rawSnapshot.visibleTexts || []);

  const notes: string[] = [
    '当前结构化结果来自页面可见 DOM 提取，仅用于第一段草稿生成',
    '进入第二段前必须人工复核按钮文案、字段映射与断言策略',
  ];
  const uncertainties: string[] = [];

  if (openButtonCandidates.length === 0) {
    uncertainties.push('未识别到新增/添加类按钮，请人工确认 openButtonText');
  }
  if (submitButtonCandidates.length === 0) {
    uncertainties.push('未识别到提交/确定类按钮，请人工确认 submitButtonText');
  }
  if (formFieldCandidates.length === 0) {
    uncertainties.push('未识别到可用字段候选，请人工补齐 form.fields');
  }
  if (tableColumnCandidates.length === 0) {
    uncertainties.push('未识别到表格列，请人工补齐 search.expectedColumns');
  }
  if (tableRowSamples.length === 0) {
    uncertainties.push('未识别到表格样例行，级联/地址等字段值可能缺少可参考样本');
  }
  if (dialogTitleCandidates.length === 0) {
    uncertainties.push('未识别到弹窗标题，请人工确认 dialogTitle');
  }
  if (searchTriggerCandidates.length === 0) {
    uncertainties.push('未识别到搜索按钮，请人工确认 search.triggerButtonText');
  }

  return {
    pageTitle: normalizeText(pageTitle),
    currentUrl: normalizeText(currentUrl),
    menuCandidates,
    linkCandidates,
    openButtonCandidates,
    submitButtonCandidates,
    closeButtonCandidates,
    searchTriggerCandidates,
    resetButtonCandidates,
    dialogTitleCandidates,
    rowActionButtonCandidates,
    successTextCandidates,
    formFieldCandidates,
    dateFieldCandidates,
    radioCandidates,
    checkboxCandidates,
    selectLikeFieldCandidates,
    searchFieldCandidates,
    tableColumnCandidates,
    tableRowSamples,
    visibleTexts,
    notes,
    uncertainties,
  };
}
