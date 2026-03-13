import type { Stage1FieldCandidate, Stage1Request, Stage1StructuredSnapshot } from './types';

type DraftField = {
  label: string;
  componentType: 'input' | 'textarea' | 'cascader' | string;
  value: string | string[];
  required?: boolean;
  unique?: boolean;
  hints?: string[];
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

function guessFieldComponentType(label: string, placeholder?: string): DraftField['componentType'] {
  const merged = `${label}${placeholder || ''}`;
  if (/(省市区|区域|街道|城市)/.test(merged)) {
    return 'cascader';
  }
  if (/(地址|描述|备注|说明|详情)/.test(merged)) {
    return 'textarea';
  }
  return 'input';
}

function buildFieldValue(field: Stage1FieldCandidate): string | string[] {
  if (/(省市区|区域|街道|城市)/.test(field.label)) {
    return ['待确认一级', '待确认二级', '待确认三级'];
  }
  if (/(名称|编号|编码)/.test(field.label)) {
    return `${field.label}_\${NOW_YYYYMMDDHHMMSS}`;
  }
  return '待人工确认';
}

function mapDraftFields(fieldCandidates: Stage1FieldCandidate[]): DraftField[] {
  const candidates = fieldCandidates.slice(0, 12);
  if (candidates.length === 0) {
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

  return candidates.map((field, index) => ({
    label: field.label,
    componentType: guessFieldComponentType(field.label, field.placeholder),
    value: buildFieldValue(field),
    required: field.required === true,
    unique: /(名称|编号|编码)/.test(field.label) || index === 0,
    hints: uniqueNonEmpty([
      field.placeholder ? `占位文案候选：${field.placeholder}` : '',
      '由第一段自动提取，进入第二段前请人工复核',
    ]),
  }));
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
    const semantic = fieldLabels.find((label) => {
      if (/(名称|名)/.test(column)) {
        return /(名称|名|标题)/.test(label);
      }
      if (/(地址|地区)/.test(column)) {
        return /(地址|地区|省市区)/.test(label);
      }
      if (/(电话|手机号|联系方式)/.test(column)) {
        return /(电话|手机号|联系方式)/.test(label);
      }
      if (/(负责人|联系人)/.test(column)) {
        return /(负责人|联系人)/.test(label);
      }
      if (/(状态)/.test(column)) {
        return /(状态)/.test(label);
      }
      return false;
    });
    if (semantic) {
      mapped[column] = semantic;
      return;
    }
    unmapped.push(column);
  });

  return { mapped, unmapped };
}

/**
 * 基于第一段结构化结果生成第二段任务草稿。
 * @author Jiane
 */
export function generateStage2DraftTask(
  request: Stage1Request,
  snapshot: Stage1StructuredSnapshot,
): Stage1DraftBuildResult {
  const draftFields = mapDraftFields(snapshot.formFieldCandidates);
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
  const containsColumn = expectedColumns.find((column) => /(地址|地区)/.test(column));
  const containsField = draftFields.find((field) => /(地址|地区|省市区)/.test(field.label));
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
        '待人工确认',
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
