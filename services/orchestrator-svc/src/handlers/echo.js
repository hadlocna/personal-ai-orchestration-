const { internalFetch } = require('@repo/common');

async function executeEchoTask({ task }) {
  const baseUrl = process.env.ECHO_AGENT_URL;
  if (!baseUrl) {
    throw new Error('ECHO_AGENT_URL not configured');
  }

  const url = new URL('/echo', baseUrl).toString();
  const response = await internalFetch(url, {
    method: 'POST',
    body: {
      traceId: task.trace_id,
      payload: task.payload
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Echo agent error: ${response.status} ${text}`);
  }

  return response.json();
}

module.exports = {
  executeEchoTask
};
