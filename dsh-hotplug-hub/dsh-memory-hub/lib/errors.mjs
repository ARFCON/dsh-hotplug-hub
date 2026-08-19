/**
 * dsh-memory-hub / lib/errors.mjs — 结构化领域错误（零依赖）。
 *
 * 所有错误带 `code` + 可选 `details`，可被模型/调用方程序化识别；
 * 遵循「失败要大声」：绝不静默吞、绝不静默截断。
 */

export class MemoryHubError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'MemoryHubError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** 写满预算：绝不截断，提示 consolidate/remove 后重试。 */
export class BudgetExceededError extends MemoryHubError {
  constructor(message, details) {
    super('BUDGET_EXCEEDED', message, details)
    this.name = 'BudgetExceededError'
  }
}

/** 引用歧义：子串命中 0 或 >1 条，须用更长标识。 */
export class AmbiguousMatchError extends MemoryHubError {
  constructor(message, details) {
    super('AMBIGUOUS_MATCH', message, details)
    this.name = 'AmbiguousMatchError'
  }
}

/** 一条 subject 一活跃值被占：报 holder id，建议改为更新成 revision。 */
export class SubjectConflictError extends MemoryHubError {
  constructor(message, details) {
    super('SUBJECT_CONFLICT', message, details)
    this.name = 'SubjectConflictError'
  }
}

/** 写入未获批（审批拒绝或 writePolicy off）。 */
export class WriteDeniedError extends MemoryHubError {
  constructor(message, details) {
    super('WRITE_DENIED', message, details)
    this.name = 'WriteDeniedError'
  }
}

/** 目标不存在或已归档。 */
export class NotFoundError extends MemoryHubError {
  constructor(message, details) {
    super('NOT_FOUND', message, details)
    this.name = 'NotFoundError'
  }
}

/** 输入非法（字段/枚举/格式）。 */
export class InvalidInputError extends MemoryHubError {
  constructor(message, details) {
    super('INVALID_INPUT', message, details)
    this.name = 'InvalidInputError'
  }
}
