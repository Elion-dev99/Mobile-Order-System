/**
 * AWS bridge for Cloudflare Pages Functions (vendored aws4fetch).
 * Optional: STS ping, EventBridge, SQS, SNS. Credentials from Pages secrets only.
 */

import { AwsClient } from './_vendor/aws4fetch.mjs';

export function awsRegion(env) {
  return String(env?.AWS_REGION || 'ap-northeast-1').trim();
}

export function isAwsConfigured(env) {
  return !!(env?.AWS_ACCESS_KEY_ID && env?.AWS_SECRET_ACCESS_KEY);
}

export function awsTargets(env) {
  return {
    region: awsRegion(env),
    eventBus: String(env?.AWS_EVENT_BUS_NAME || '').trim(),
    sqsQueueUrl: String(env?.AWS_SQS_QUEUE_URL || '').trim(),
    snsTopicArn: String(env?.AWS_SNS_TOPIC_ARN || '').trim(),
    incidentMirror: String(env?.AWS_MIRROR_INCIDENTS || 'true').toLowerCase() !== 'false',
  };
}

function client(env) {
  if (!isAwsConfigured(env)) return null;
  return new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: awsRegion(env),
  });
}

async function parseAwsXmlAccount(text) {
  const m = String(text).match(/<Account>(\d+)<\/Account>/);
  return m ? m[1] : null;
}

export async function awsStsPing(env) {
  const aws = client(env);
  if (!aws) return { ok: false, skipped: true, reason: 'not_configured' };
  const region = awsRegion(env);
  try {
    const res = await aws.fetch(`https://sts.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: 'Action=GetCallerIdentity&Version=2011-06-15',
    });
    const text = await res.text();
    const account = await parseAwsXmlAccount(text);
    return {
      ok: res.ok,
      status: res.status,
      account,
      region,
      raw: text.slice(0, 400),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function awsEventBridgePut(env, detailType, detail, source = 'quickorder.system') {
  const aws = client(env);
  const { eventBus } = awsTargets(env);
  if (!aws) return { ok: false, skipped: true, reason: 'not_configured' };
  const region = awsRegion(env);
  const entry = {
    Source: source,
    DetailType: String(detailType || 'QuickOrderEvent').slice(0, 128),
    Detail: JSON.stringify(detail || {}),
    Time: new Date().toISOString(),
  };
  if (eventBus) entry.EventBusName = eventBus;
  const body = JSON.stringify({ Entries: [entry] });
  try {
    const res = await aws.fetch(`https://events.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSEvents.PutEvents',
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && !json.FailedEntryCount, status: res.status, data: json };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function awsSqsSend(env, message) {
  const aws = client(env);
  const { sqsQueueUrl } = awsTargets(env);
  if (!aws || !sqsQueueUrl) return { ok: false, skipped: true, reason: 'no_queue_url' };
  const params = new URLSearchParams({
    Action: 'SendMessage',
    Version: '2012-11-05',
    MessageBody: String(message).slice(0, 240000),
  });
  try {
    const res = await aws.fetch(sqsQueueUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: params.toString(),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, raw: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function awsSnsPublish(env, subject, message) {
  const aws = client(env);
  const { snsTopicArn } = awsTargets(env);
  if (!aws || !snsTopicArn) return { ok: false, skipped: true, reason: 'no_topic_arn' };
  const params = new URLSearchParams({
    Action: 'Publish',
    Version: '2010-03-31',
    TopicArn: snsTopicArn,
    Subject: String(subject || 'QuickOrder').slice(0, 100),
    Message: String(message).slice(0, 240000),
  });
  try {
    const res = await aws.fetch('https://sns.' + awsRegion(env) + '.amazonaws.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: params.toString(),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, raw: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Mirror system incident to EventBridge (+ optional SQS) for Lambda / Step Functions later. */
export async function mirrorSystemIncidentToAws(env, row = {}) {
  const targets = awsTargets(env);
  if (!isAwsConfigured(env) || !targets.incidentMirror) {
    return { ok: false, skipped: true, reason: 'mirror_off_or_not_configured' };
  }
  const detail = {
    id: row.id,
    feature: row.feature,
    cause: row.cause,
    kind: row.kind,
    severity: row.severity,
    shopId: row.shopId,
    url: row.url,
    count: row.count,
    at: row.lastAt || Date.now(),
  };
  const eb = await awsEventBridgePut(env, 'SystemIncident', detail);
  let sqs = { skipped: true };
  if (targets.sqsQueueUrl) {
    sqs = await awsSqsSend(env, JSON.stringify(detail));
  }
  return { ok: eb.ok || sqs.ok, eventBridge: eb, sqs };
}
