import type { Stage1FieldCandidate, Stage1Request, Stage1StructuredSnapshot } from './types';

type DraftField = {
  label: string;
  componentType: 'input' | 'textarea' | 'cascader' | string;
  value: string | string[];
  required?: boolean;
  unique?: boolean;
  hints?: string[];
};

type FieldInferenceContext = {
  cascaderLevels: string[];
  addressValue: string;
  contactName: string;
  phoneValue: string;
};

export type Stage1DraftMappingReport = {
  primaryMatchField: string;
  searchInputLabel: string;
  dialogTitle: string;
  openButtonText: string;
  submitButtonText: string;
  expectedColumns: string[];
  expectedColumnFromFields: Record<string, string>;
  unmappedColumns: string[];
  rowActionButtonCandidates: string[];
  uncertainties: string[];
};

export type Stage1DraftBuildResult = {
  draftTask: Record<string, unknown>;
  mappingReport: Stage1DraftMappingReport;
};

const NOW_TOKEN = '${NOW_YYYYMMDDHHMMSS}';

function uniqueNonEmpty(values: string[]): string[] {
  const filtered = values
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(filtered)];
}

function pickFirst(values: string[], fallback: string): string {
  const candidate = values.find((item) => item.trim().length > 0);
  return candidate || fallback;
}

function normalizeKey(input: string): string {
  return input.replace(/\s+/g, '').replace(/[：:()/]/g, '').trim().toLowerCase();
}

function normalizeFieldLabel(input: string): string {
  return input.replace(/\s+/g, ' ').replace(/[：:]\s*$/g, '').trim();
}

function normalizeFieldPlaceholder(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  const normalized = input.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function scorePlaceholder(input?: string): number {
  if (!input) {
    return 0;
  }
  let score = input.length;
  if (/请输入|请选择/.test(input)) {
    score += 20;
  }
  if (/手机号|联系电话|负责人|地址|名称/.test(input)) {
    score += 10;
  }
  return score;
}

function mergeFieldCandidates(fieldCandidates: Stage1FieldCandidate[]): Stage1FieldCandidate[] {
  const merged = new Map<string, Stage1FieldCandidate>();
  fieldCandidates.forEach((rawField) => {
    const label = normalizeFieldLabel(rawField.label || '');
    if (!label) {
      return;
    }
    const key = normalizeKey(label);
    const placeholder = normalizeFieldPlaceholder(rawField.placeholder);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        label,
        placeholder,
        required: rawField.required === true,
      });
      return;
    }
    const existingPlaceholder = normalizeFieldPlaceholder(existing.placeholder);
    const finalPlaceholder = scorePlaceholder(placeholder) > scorePlaceholder(existingPlaceholder)
      ? placeholder
      : existingPlaceholder;
    merged.set(key, {
      label: existing.label,
      placeholder: finalPlaceholder,
      required: existing.required === true || rawField.required === true,
    });
  });
  return [...merged.values()];
}

function guessFieldComponentType(label: string, placeholder?: string): DraftField['componentType'] {
  const merged = `${label}${placeholder || ''}`;
  if (/(省市区|区域|街道|城市|级联)/.test(merged)) {
    return 'cascader';
  }
  if (/(地址|描述|备注|说明|详情)/.test(merged)) {
    return 'textarea';
  }
  return 'input';
}

function findFirstCellValueByColumn(
  columns: string[],
  rows: string[][],
  columnPattern: RegExp,
): string {
  const index = columns.findIndex((column) => columnPattern.test(column));
  if (index < 0) {
    return '';
  }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (index < row.length && row[index] && row[index].trim().length > 0) {
      return row[index].trim();
    }
  }
  return '';
}

function findFirstCellValueByPattern(rows: string[][], valuePattern: RegExp): string {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    for (let j = 0; j < row.length; j += 1) {
      const cell = row[j].trim();
      if (cell.length === 0) {
        continue;
      }
      if (valuePattern.test(cell)) {
        return cell;
      }
    }
  }
  return '';
}

function parseCascaderLevels(rawValue: string): string[] {
  const normalized = rawValue.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return [];
  }
  const explicitParts = uniqueNonEmpty(
    normalized
      .split(/[\/\\>|,，;；\-—]+/)
      .map((item) => item.trim()),
  );
  if (explicitParts.length >= 2) {
    return explicitParts.slice(0, 3);
  }
  const regionMatches = normalized.match(
    /[\u4e00-\u9fa5A-Za-z]{1,20}(?:特别行政区|自治区|自治州|省|市|区|县|旗|州|盟)/g,
  );
  if (regionMatches && regionMatches.length > 0) {
    return uniqueNonEmpty(regionMatches).slice(0, 3);
  }
  return [];
}

function normalizePhone(rawValue: string): string {
  const digits = rawValue.replace(/\D/g, '');
  const mobileMatch = digits.match(/1\d{10}/);
  if (mobileMatch && mobileMatch[0]) {
    return mobileMatch[0];
  }
  return '';
}

function inferFieldContext(snapshot: Stage1StructuredSnapshot): FieldInferenceContext {
  const columns = snapshot.tableColumnCandidates || [];
  const rowSamples = snapshot.tableRowSamples || [];

  const regionRawValue = findFirstCellValueByColumn(
    columns,
    rowSamples,
    /(所在地区|省市区|地区|区域|城市)/,
  ) || findFirstCellValueByPattern(
    rowSamples,
    /(省|市|区|县|特别行政区|自治区|自治州)/,
  );

  const addressValue = findFirstCellValueByColumn(
    columns,
    rowSamples,
    /(详细地址|地址)/,
  );

  const contactName = findFirstCellValueByColumn(
    columns,
    rowSamples,
    /(负责人|联系人|姓名)/,
  );

  const phoneFromColumn = findFirstCellValueByColumn(
    columns,
    rowSamples,
    /(联系电话|手机号|电话|联系方式)/,
  );
  const phoneValue = normalizePhone(
    phoneFromColumn
    || findFirstCellValueByPattern(rowSamples, /1\d{10}/),
  );

  return {
    cascaderLevels: parseCascaderLevels(regionRawValue),
    addressValue: addressValue.trim(),
    contactName: contactName.trim(),
    phoneValue,
  };
}

function buildFieldValue(
  field: Stage1FieldCandidate,
  componentType: DraftField['componentType'],
  context: FieldInferenceContext,
): string | string[] {
  const label = normalizeFieldLabel(field.label);
  if (componentType === 'cascader') {
    if (context.cascaderLevels.length > 0) {
      return context.cascaderLevels;
    }
    return ['待确认一级', '待确认二级', '待确认三级'];
  }
  if (/(电话|手机号|手机|联系电话|联系方式)/.test(label)) {
    return context.phoneValue || '13800138000';
  }
  if (/(负责人|联系人|姓名)/.test(label)) {
    return context.contactName || '测试联系人';
  }
  if (/(地址|住址|详细地址)/.test(label)) {
    const baseAddress = context.addressValue || '测试地址';
    return `${baseAddress}_${NOW_TOKEN}`;
  }
  if (/(名称|标题|编号|编码)/.test(label)) {
    return `${label}_${NOW_TOKEN}`;
  }
  return '待人工确认';
}

function shouldMarkRequired(
  label: string,
  componentType: DraftField['componentType'],
  explicitRequired: boolean,
): boolean {
  if (explicitRequired) {
    return true;
  }
  if (componentType === 'cascader') {
    return true;
  }
  if (/(名称|地址|地区|区域|城市|省市区)/.test(label)) {
    return true;
  }
  return false;
}

function mapDraftFields(snapshot: Stage1StructuredSnapshot): DraftField[] {
  const mergedCandidates = mergeFieldCandidates(snapshot.formFieldCandidates || []).slice(0, 12);
  if (mergedCandidates.length === 0) {
    return [
      {
        label: '待确认字段',
        componentType: 'input',
        value: '待人工确认',
        required: true,
        unique: false,
        hints: ['第一段未识别到字段，请人工补齐'],
      },
    ];
  }

  const context = inferFieldContext(snapshot);
  return mergedCandidates.map((field, index) => {
    const normalizedLabel = normalizeFieldLabel(field.label);
    const normalizedPlaceholder = normalizeFieldPlaceholder(field.placeholder);
    const componentType = guessFieldComponentType(normalizedLabel, normalizedPlaceholder);
    const value = buildFieldValue(
      {
        ...field,
        label: normalizedLabel,
        placeholder: normalizedPlaceholder,
      },
      componentType,
      context,
    );
    const cascaderHint = componentType === 'cascader' && context.cascaderLevels.length > 0
      ? `由列表样例推断级联路径：${context.cascaderLevels.join('/')}`
      : '';
    return {
      label: normalizedLabel,
      componentType,
      value,
      required: shouldMarkRequired(
        normalizedLabel,
        componentType,
        field.required === true,
      ),
      unique: /(名称|编号|编码)/.test(normalizedLabel) || index === 0,
      hints: uniqueNonEmpty([
        normalizedPlaceholder ? `占位文案候选：${normalizedPlaceholder}` : '',
        cascaderHint,
        '字段标签已标准化（去除前后空白与尾随冒号）',
        '由第一段自动提取，进入第二段前请人工复核',
      ]),
    };
  });
}

function mapExpectedColumnsFromFields(
  expectedColumns: string[],
  fields: DraftField[],
): { mapped: Record<string, string>; unmapped: string[] } {
  const mapped: Record<string, string> = {};
  const unmapped: string[] = [];
  const fieldLabels = fields.map((item) => item.label);

  expectedColumns.forEach((column) => {
    const columnKey = normalizeKey(column);
    const exact = fieldLabels.find((label) => normalizeKey(label) === columnKey);
    if (exact) {
      mapped[column] = exact;
      return;
    }
    const contain = fieldLabels.find((label) => {
      const labelKey = normalizeKey(label);
      return labelKey.includes(columnKey) || columnKey.includes(labelKey);
    });
    if (contain) {
      mapped[column] = contain;
      return;
    }
    let semantic: string | undefined;
    if (/(所在地区|省市区|地区|区域|城市)/.test(column)) {
      semantic = fieldLabels.find((label) => /(省市区|地区|区域|城市)/.test(label))
        || fieldLabels.find((label) => /(地址)/.test(label));
    } else if (/(详细地址|地址)/.test(column)) {
      semantic = fieldLabels.find((label) => /(地址)/.test(label));
    } else if (/(电话|手机号|联系方式)/.test(column)) {
      semantic = fieldLabels.find((label) => /(电话|手机号|联系方式)/.test(label));
    } else if (/(负责人|联系人)/.test(column)) {
      semantic = fieldLabels.find((label) => /(负责人|联系人|姓名)/.test(label));
    } else if (/(名称|名|标题)/.test(column)) {
      semantic = fieldLabels.find((label) => /(名称|名|标题|编号|编码)/.test(label));
    } else if (/(状态)/.test(column)) {
      semantic = fieldLabels.find((label) => /(状态)/.test(label));
    }
    if (semantic) {
      mapped[column] = semantic;
      return;
    }
    unmapped.push(column);
  });

  return { mapped, unmapped };
}

function pickContainsField(
  containsColumn: string,
  draftFields: DraftField[],
): DraftField | undefined {
  if (/(所在地区|省市区|地区|区域|城市)/.test(containsColumn)) {
    return draftFields.find((field) => /(省市区|地区|区域|城市)/.test(field.label))
      || draftFields.find((field) => /(地址)/.test(field.label));
  }
  return draftFields.find((field) => /(地址|地区|省市区)/.test(field.label));
}

/**
 * 基于第一段结构化结果生成第二段任务草稿。
 * @author Jiane
 */
export function generateStage2DraftTask(
  request: Stage1Request,
  snapshot: Stage1StructuredSnapshot,
): Stage1DraftBuildResult {
  const draftFields = mapDraftFields(snapshot);
  const primaryMatchField = pickFirst(
    draftFields
      .map((item) => item.label)
      .filter((label) => /(名称|编号|编码)/.test(label)),
    draftFields[0].label,
  );

  const searchInputLabel = pickFirst(snapshot.searchFieldCandidates, primaryMatchField);
  const triggerButtonText = pickFirst(
    snapshot.searchTriggerCandidates,
    '搜索',
  );
  const resetButtonText = pickFirst(
    snapshot.resetButtonCandidates,
    '重置',
  );

  const expectedColumns = uniqueNonEmpty(snapshot.tableColumnCandidates).slice(0, 8);
  const expectedColumnMapping = mapExpectedColumnsFromFields(expectedColumns, draftFields);
  const tableCellCheckColumns = expectedColumns
    .filter((column) => Boolean(expectedColumnMapping.mapped[column]))
    .slice(0, 4);

  const assertions: Record<string, unknown>[] = [];
  if (snapshot.successTextCandidates.length > 0) {
    assertions.push({
      type: 'toast',
      expectedText: snapshot.successTextCandidates[0],
      timeoutMs: 10000,
      retryCount: 2,
      soft: true,
    });
  }
  assertions.push({
    type: 'table-row-exists',
    matchField: primaryMatchField,
    matchMode: 'exact',
    timeoutMs: 10000,
    retryCount: 2,
  });
  if (tableCellCheckColumns.length > 0) {
    const expectedColumnFromFields: Record<string, string> = {};
    tableCellCheckColumns.forEach((column) => {
      const mappedField = expectedColumnMapping.mapped[column];
      if (mappedField) {
        expectedColumnFromFields[column] = mappedField;
      }
    });
    assertions.push({
      type: 'table-cell-equals',
      matchField: primaryMatchField,
      expectedColumns: tableCellCheckColumns,
      expectedColumnFromFields,
      retryCount: 2,
      soft: true,
    });
  }
  const containsColumn = expectedColumns.find((column) => /(地址|地区|省市区)/.test(column));
  const containsField = containsColumn
    ? pickContainsField(containsColumn, draftFields)
    : undefined;
  if (containsColumn && containsField) {
    assertions.push({
      type: 'table-cell-contains',
      matchField: primaryMatchField,
      column: containsColumn,
      expectedFromField: containsField.label,
      retryCount: 2,
      soft: true,
    });
  }

  const dialogTitle = pickFirst(
    snapshot.dialogTitleCandidates,
    pickFirst(
      snapshot.visibleTexts.filter((item) => /(新增|新建|创建)/.test(item)),
      '待人工确认',
    ),
  );
  const openButtonText = pickFirst(snapshot.openButtonCandidates, '待人工确认');
  const submitButtonText = pickFirst(snapshot.submitButtonCandidates, '待人工确认');
  const controlSummary = `控件探索摘要：链接${snapshot.linkCandidates.length}、日期${snapshot.dateFieldCandidates.length}、单选${snapshot.radioCandidates.length}、多选${snapshot.checkboxCandidates.length}、下拉/级联${snapshot.selectLikeFieldCandidates.length}`;

  const draftTask = {
    taskId: `draft-${request.requestId}`,
    taskName: `${request.requestName}-草稿`,
    target: {
      url: request.target.url,
      browser: request.target.browser || 'chromium',
      headless: request.target.headless ?? false,
    },
    account: {
      username: request.account.username,
      password: request.account.password,
      loginHints: request.account.loginHints || [],
    },
    navigation: {
      homeReadyText: pickFirst(
        snapshot.visibleTexts.filter((item) => /(首页|控制台|工作台)/.test(item)),
        '首页',
      ),
      menuPath: request.scope?.menuPathHints || snapshot.menuCandidates.slice(0, 2),
      menuHints: uniqueNonEmpty([
        '菜单路径由第一段自动提取，请人工确认是否准确',
        ...snapshot.menuCandidates.slice(0, 5).map((item) => `菜单候选：${item}`),
      ]),
    },
    uiProfile: {
      tableRowSelectors: [
        'table tbody tr',
        '.el-table__body tr',
        '.ant-table-tbody tr',
      ],
      toastSelectors: ['.el-message', '.ant-message', '[role="alert"]'],
      dialogSelectors: ['div[role="dialog"]', '.el-dialog__wrapper', '.ant-modal-wrap'],
    },
    form: {
      openButtonText,
      dialogTitle,
      submitButtonText,
      closeButtonText: pickFirst(snapshot.closeButtonCandidates, '待人工确认'),
      successText: snapshot.successTextCandidates[0],
      notes: uniqueNonEmpty([
        request.goal.scenarioDescription,
        request.goal.expectedOutcome || '',
        controlSummary,
        ...snapshot.notes,
        ...snapshot.uncertainties,
      ]),
      fields: draftFields,
    },
    search: {
      inputLabel: searchInputLabel,
      keywordFromField: primaryMatchField,
      triggerButtonText,
      resetButtonText,
      resultTableTitle: pickFirst(
        snapshot.visibleTexts.filter((item) => /(列表|数据|信息)/.test(item)),
        snapshot.pageTitle || '待人工确认',
      ),
      expectedColumns,
      rowActionButtons: snapshot.rowActionButtonCandidates.slice(0, 8),
      notes: uniqueNonEmpty([
        '搜索区字段由第一段自动识别，请人工确认',
      ]),
    },
    assertions,
    cleanup: {
      enabled: false,
      strategy: 'none',
      notes: '第一段草稿默认不开启清理，请人工补充',
    },
    approval: {
      approved: request.review?.required === true ? false : true,
      approvedBy: request.review?.reviewer || 'stage1-auto',
      approvedAt: new Date().toISOString(),
    },
    runtime: {
      stepTimeoutMs: request.runtime?.stepTimeoutMs || 30000,
      pageTimeoutMs: request.runtime?.pageTimeoutMs || 60000,
      screenshotOnStep: request.runtime?.screenshotOnStep !== false,
      trace: true,
    },
  };

  const uncertainties = uniqueNonEmpty([
    ...snapshot.uncertainties,
    expectedColumnMapping.unmapped.length > 0
      ? `以下列未找到对应字段映射：${expectedColumnMapping.unmapped.join('、')}`
      : '',
    openButtonText === '待人工确认'
      ? 'openButtonText 尚未自动识别，请人工确认'
      : '',
    submitButtonText === '待人工确认'
      ? 'submitButtonText 尚未自动识别，请人工确认'
      : '',
    dialogTitle === '待人工确认'
      ? 'dialogTitle 尚未自动识别，请人工确认'
      : '',
  ]);

  return {
    draftTask,
    mappingReport: {
      primaryMatchField,
      searchInputLabel,
      dialogTitle,
      openButtonText,
      submitButtonText,
      expectedColumns,
      expectedColumnFromFields: expectedColumnMapping.mapped,
      unmappedColumns: expectedColumnMapping.unmapped,
      rowActionButtonCandidates: snapshot.rowActionButtonCandidates.slice(0, 10),
      uncertainties,
    },
  };
}
