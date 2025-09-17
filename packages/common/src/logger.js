const { internalFetch } = require('./internalFetch');

function createServiceLogger({ service, loggingUrl, broadcast }) {
  if (!service) throw new Error('Logger requires service name');
  if (!loggingUrl) throw new Error('Logger requires loggingUrl');

  function emit(level, message, metadata = {}) {
    if (!message) return;

    const body = {
      service,
      level,
      message,
      data: metadata.data || null,
      taskId: metadata.taskId || null,
      correlationId: metadata.correlationId || null,
      traceId: metadata.traceId || null
    };

    queueMicrotask(async () => {
      try {
        const response = await internalFetch(`${loggingUrl.replace(/\/$/, '')}/log`, {
          method: 'POST',
          body
        });

        if (response.ok) {
          const json = await response.json();
          if (broadcast) {
            broadcast({ type: 'LOG', data: json.log });
          }
        } else {
          const errText = await response.text();
          console.error('Failed to emit log', response.status, errText);
        }
      } catch (err) {
        console.error('Error emitting log', err);
      }
    });
  }

  function emitTaskEvent(event = {}) {
    const body = {
      taskId: event.taskId,
      actor: event.actor,
      kind: event.kind,
      data: event.data || null,
      correlationId: event.correlationId || null,
      traceId: event.traceId || null
    };

    queueMicrotask(async () => {
      try {
        const response = await internalFetch(`${loggingUrl.replace(/\/$/, '')}/task/event`, {
          method: 'POST',
          body
        });

        if (response.ok) {
          const json = await response.json();
          if (broadcast) {
            broadcast({ type: 'TASK_EVENT', data: json.event });
          }
        } else {
          const errText = await response.text();
          console.error('Failed to emit task event', response.status, errText);
        }
      } catch (err) {
        console.error('Error emitting task event', err);
      }
    });
  }

  return {
    info: (message, metadata) => emit('info', message, metadata),
    warn: (message, metadata) => emit('warn', message, metadata),
    error: (message, metadata) => emit('error', message, metadata),
    taskEvent: emitTaskEvent
  };
}

module.exports = {
  createServiceLogger
};
