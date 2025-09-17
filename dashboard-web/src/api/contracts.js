/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} type
 * @property {string} status
 * @property {string} source
 * @property {Object} payload
 * @property {Object|null} result
 * @property {Object|null} error
 * @property {string|null} correlation_id
 * @property {string} trace_id
 * @property {number} version
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} TaskEvent
 * @property {string} id
 * @property {string} task_id
 * @property {string} ts_utc
 * @property {string} actor
 * @property {string} kind
 * @property {Object|null} data
 */

/**
 * @typedef {Object} TaskWithEvents
 * @property {Task} task
 * @property {TaskEvent[]} events
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} id
 * @property {string} ts_utc
 * @property {string} service
 * @property {string} level
 * @property {string} message
 * @property {Object|null} data
 * @property {string|null} task_id
 * @property {string|null} correlation_id
 * @property {string|null} trace_id
 */

/**
 * @typedef {Object} WsFrame
 * @property {string} ts
 * @property {string} type
 * @property {Object} data
 */

module.exports = {
  // Expose typedefs for tooling via require side-effect
};
