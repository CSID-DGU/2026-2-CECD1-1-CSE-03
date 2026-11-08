'use strict';
// infra/cs-agent.cfn.json 불변식 — JSON.parse만 쓴다(AWS SDK·네트워크 없음).
// 운영 모델 호출은 Claude API 키 직접 호출이다. 키는 Secrets Manager에만 있고 AWS 모델 권한은 없다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'infra', 'cs-agent.cfn.json');
const RAW = fs.readFileSync(FILE, 'utf8');
const T = JSON.parse(RAW);
const R = T.Resources;
const ofType = (type) => Object.entries(R).filter(([, r]) => r.Type === type);
const one = (type) => { const l = ofType(type); assert.equal(l.length, 1, type); return l[0]; };
const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const refTo = (x, id) => x && x.Ref === id;
const attTo = (x, id, a) => x && Array.isArray(x['Fn::GetAtt']) && x['Fn::GetAtt'][0] === id && x['Fn::GetAtt'][1] === a;
// Fn::Join(줄 배열) 또는 문자열을 한 문자열로. Fn::Sub 줄은 원문 그대로 둔다.
const text = (c) => (typeof c === 'string' ? c : c['Fn::Join'][1].map((l) => (typeof l === 'string' ? l : l['Fn::Sub'])).join(c['Fn::Join'][0]));
const subs = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => subs(n, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) (k === 'Fn::Sub' ? out.push(typeof v === 'string' ? v : v[0]) : subs(v, out));
  return out;
};
const subNames = (s) => [...s.matchAll(/\$\{([^!}][^}]*)\}/g)].map((m) => m[1].split('.')[0]);

const [, instance] = one('AWS::EC2::Instance');
const init = instance.Metadata['AWS::CloudFormation::Init'].config.files;
const userData = instance.Properties.UserData['Fn::Base64'];
const envScript = text(init['/usr/local/bin/cs-agent-env'].content);

test('E1: 보안 그룹 인바운드 0, 아웃바운드는 443·587만', () => {
  assert.equal(ofType('AWS::EC2::SecurityGroupIngress').length, 0);
  for (const [id, sg] of ofType('AWS::EC2::SecurityGroup')) {
    assert.equal(sg.Properties.SecurityGroupIngress, undefined, id);
    assert.deepEqual(sg.Properties.SecurityGroupEgress.map((e) => [e.IpProtocol, e.FromPort, e.ToPort]), [['tcp', 443, 443], ['tcp', 587, 587]], id);
  }
  // 바깥으로 나가는 길(Claude API): 공개 서브넷 + IGW 기본 경로
  const [, route] = one('AWS::EC2::Route');
  assert.equal(route.Properties.DestinationCidrBlock, '0.0.0.0/0');
  assert.ok(refTo(route.Properties.GatewayId, one('AWS::EC2::InternetGateway')[0]));
  assert.equal(one('AWS::EC2::Subnet')[1].Properties.MapPublicIpOnLaunch, true);
  assert.equal(ofType('AWS::EC2::NatGateway').length, 0);
});

test('E2: IMDSv2 필수, 홉 1', () => {
  assert.deepEqual(instance.Properties.MetadataOptions, { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 });
  assert.equal(instance.Properties.KeyName, undefined, '키 페어 없음(SSM으로만 접속)');
});

test('E3: IAM 최소 권한 — 와일드카드·모델·발송·DLQ 재처리 권한 없음', () => {
  assert.equal(ofType('AWS::IAM::User').length + ofType('AWS::IAM::AccessKey').length + ofType('AWS::IAM::Policy').length + ofType('AWS::IAM::ManagedPolicy').length, 0);
  const roles = ofType('AWS::IAM::Role');
  const allowed = [];
  for (const [id, role] of roles) {
    for (const p of arr(role.Properties.Policies)) {
      for (const s of p.PolicyDocument.Statement) {
        assert.equal(s.Effect, 'Allow', id);
        assert.equal(s.NotAction ?? s.NotResource, undefined, id);
        const actions = arr(s.Action);
        for (const a of actions) assert.ok(!a.includes('*'), `${id} ${a}`);
        if (arr(s.Resource).includes('*')) assert.deepEqual(actions, ['ecr:GetAuthorizationToken'], `${id} Resource *`);
        if (actions.includes('s3:ListBucket')) {
          assert.deepEqual(actions, ['s3:ListBucket']);
          assert.deepEqual(s.Resource, { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${RawMailBucket}' });
        }
        allowed.push(...actions);
      }
    }
  }
  assert.deepEqual(allowed.sort(), [
    'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken', 'ecr:GetDownloadUrlForLayer',
    'logs:CreateLogStream', 'logs:PutLogEvents',
    's3:GetObject', 's3:ListBucket',
    'secretsmanager:GetSecretValue',
    'sqs:ChangeMessageVisibility', 'sqs:DeleteMessage', 'sqs:ReceiveMessage',
    'ssm:GetParameter',
  ]);
  const managed = Object.fromEntries(roles.map(([id, r]) => [id, arr(r.Properties.ManagedPolicyArns).map((m) => m['Fn::Sub'] || m)]));
  assert.deepEqual(managed, {
    InstanceRole: ['arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore'],
    DlmRole: ['arn:${AWS::Partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole'],
  });
  assert.ok(!/bedrock/i.test(RAW), 'Bedrock 흔적 없음');
  assert.ok(!/"ses:|StartMessageMoveTask/.test(RAW), '메일 발송·DLQ 재처리 권한 없음');
  // 자원 정책의 Allow는 서비스 주체 + 출처 조건
  for (const type of ['AWS::S3::BucketPolicy', 'AWS::SNS::TopicPolicy', 'AWS::SQS::QueuePolicy']) {
    for (const [id, p] of ofType(type)) {
      for (const s of p.Properties.PolicyDocument.Statement.filter((x) => x.Effect === 'Allow')) {
        assert.equal(typeof s.Principal.Service, 'string', id);
        assert.ok(JSON.stringify(s.Condition).match(/SourceArn/i), `${id} SourceArn`);
      }
    }
  }
});

test('E4: EBS 암호화, 데이터 볼륨 Snapshot 정책, DLM 대상 태그·UTC 시각', () => {
  for (const b of instance.Properties.BlockDeviceMappings) assert.equal(b.Ebs.Encrypted, true);
  const [volId, vol] = one('AWS::EC2::Volume');
  assert.equal(vol.Properties.Encrypted, true);
  assert.equal(vol.DeletionPolicy, 'Snapshot');
  assert.equal(vol.UpdateReplacePolicy, 'Snapshot');
  assert.ok(attTo(vol.Properties.AvailabilityZone, one('AWS::EC2::Subnet')[0], 'AvailabilityZone'), '인스턴스와 같은 AZ');
  const [, att] = one('AWS::EC2::VolumeAttachment');
  assert.ok(refTo(att.Properties.VolumeId, volId));
  const d = one('AWS::DLM::LifecyclePolicy')[1].Properties.PolicyDetails;
  assert.deepEqual(d.TargetTags, vol.Properties.Tags.filter((t) => t.Key === 'cs-agent-backup'));
  assert.equal(d.TargetTags.length, 1);
  const rule = d.Schedules[0].CreateRule;
  assert.equal(rule.Interval, 24);
  assert.deepEqual(rule.Times, ['18:00'], 'UTC 18:00 = KST 03:00');
  assert.ok(refTo(d.Schedules[0].RetainRule.Count, 'SnapshotRetainCount'));
});

test('E5: 원문 버킷 — 공개 차단·암호화·TLS 전용·SES 쓰기 조건·보존 = RawMailRetentionDays', () => {
  const [bucketId, b] = one('AWS::S3::Bucket');
  assert.deepEqual(b.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.equal(b.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.equal(b.DeletionPolicy, 'Retain');
  const rules = b.Properties.LifecycleConfiguration.Rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].Status, 'Enabled');
  assert.equal(rules[0].Prefix, 'inbound/');
  assert.ok(refTo(rules[0].ExpirationInDays, 'RawMailRetentionDays'));
  const [policyId, policy] = one('AWS::S3::BucketPolicy');
  assert.ok(refTo(policy.Properties.Bucket, bucketId));
  const st = policy.Properties.PolicyDocument.Statement;
  const deny = st.find((s) => s.Effect === 'Deny');
  assert.deepEqual(deny.Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  const ses = st.find((s) => s.Effect === 'Allow');
  assert.deepEqual([ses.Principal.Service, ses.Action], ['ses.amazonaws.com', 's3:PutObject']);
  assert.ok(ses.Resource['Fn::Sub'].endsWith('/inbound/*'));
  assert.ok(refTo(ses.Condition.StringEquals['AWS:SourceAccount'], 'AWS::AccountId'));
  const ruleArn = ses.Condition.StringEquals['AWS:SourceArn']['Fn::Sub'];
  const [, rr] = one('AWS::SES::ReceiptRule');
  assert.ok(ruleArn.endsWith(`receipt-rule-set/${one('AWS::SES::ReceiptRuleSet')[1].Properties.RuleSetName['Fn::Sub']}:receipt-rule/${rr.Properties.Rule.Name['Fn::Sub']}`), '규칙 ARN이 실제 이름과 같다');
  const s3a = rr.Properties.Rule.Actions[0].S3Action;
  assert.equal(s3a.KmsKeyArn, undefined, '클라이언트 측 암호화 없음');
  assert.equal(s3a.ObjectKeyPrefix, rules[0].Prefix);
  assert.ok(refTo(s3a.BucketName, bucketId));
  assert.equal(rr.Properties.Rule.TlsPolicy, 'Require');
  assert.equal(rr.Properties.Rule.ScanEnabled, true);
  const topicPolicyId = one('AWS::SNS::TopicPolicy')[0];
  for (const dep of [policyId, topicPolicyId]) assert.ok(arr(rr.DependsOn).includes(dep), dep);
});

test('E6: 큐·DLQ·SNS 사슬', () => {
  const qs = Object.fromEntries(ofType('AWS::SQS::Queue'));
  const main = qs.InboundQueue.Properties;
  const dlq = qs.DeadLetterQueue.Properties;
  assert.equal(main.SqsManagedSseEnabled, true);
  assert.equal(dlq.SqsManagedSseEnabled, true);
  assert.equal(main.MessageRetentionPeriod, 604800);
  assert.equal(dlq.MessageRetentionPeriod, 604800);
  assert.equal(main.RedrivePolicy.maxReceiveCount, 10);
  assert.ok(attTo(main.RedrivePolicy.deadLetterTargetArn, 'DeadLetterQueue', 'Arn'), 'DLQ 연결');
  assert.equal(main.VisibilityTimeout, 120);
  assert.equal(main.ReceiveMessageWaitTimeSeconds, 20);
  const [, qp] = one('AWS::SQS::QueuePolicy');
  const s = qp.Properties.PolicyDocument.Statement[0];
  assert.deepEqual([s.Principal.Service, s.Action], ['sns.amazonaws.com', 'sqs:SendMessage']);
  assert.ok(refTo(s.Condition.ArnEquals['aws:SourceArn'], 'InboundTopic'));
  const sub = ofType('AWS::SNS::Subscription').find(([, x]) => x.Properties.Protocol === 'sqs')[1].Properties;
  assert.equal(sub.RawMessageDelivery, true);
  assert.ok(refTo(sub.TopicArn, 'InboundTopic'));
  const [, tp] = one('AWS::SNS::TopicPolicy');
  const ts = tp.Properties.PolicyDocument.Statement[0];
  assert.equal(ts.Principal.Service, 'ses.amazonaws.com');
  assert.match(ts.Condition.StringEquals['AWS:SourceArn']['Fn::Sub'], /:receipt-rule\//);
  // 결정: SES가 게시하는 주제는 KMS 없음(고객 관리형 키 정책이 필요해진다). 큐 SSE로 받는다.
  assert.equal(R.InboundTopic.Properties.KmsMasterKeyId, undefined);
  const dlqAlarm = ofType('AWS::CloudWatch::Alarm').find(([, a]) => a.Properties.Namespace === 'AWS/SQS')[1].Properties;
  assert.ok(attTo(dlqAlarm.Dimensions[0].Value, 'DeadLetterQueue', 'QueueName'));
});

test('E7: 비밀은 파라미터·user data에 없고 Secrets Manager에만, MailMode 기본 mirror', () => {
  for (const name of Object.keys(T.Parameters)) assert.ok(!/SECRET|PASS|TOKEN|KEY/i.test(name), name);
  assert.equal(T.Parameters.MailMode.Default, 'mirror');
  assert.deepEqual(T.Parameters.MailMode.AllowedValues, ['mirror', 'smtp']);
  assert.ok(!RAW.includes('{{resolve:'), '동적 참조로 비밀을 풀지 않는다');
  const secrets = Object.fromEntries(ofType('AWS::SecretsManager::Secret'));
  const generated = Object.keys(secrets).filter((id) => secrets[id].Properties.GenerateSecretString).sort();
  assert.deepEqual(generated, ['AuditSaltSecret', 'InboundSecret', 'ProxySecret']);
  for (const id of generated) assert.deepEqual(secrets[id].Properties.GenerateSecretString, { PasswordLength: 48, ExcludePunctuation: true });
  const manual = Object.keys(secrets).filter((id) => !secrets[id].Properties.GenerateSecretString).sort();
  assert.deepEqual(manual, ['AnthropicApiKeySecret', 'ManualSecret']);
  for (const id of manual) {
    const v = JSON.parse(secrets[id].Properties.SecretString);
    assert.ok(Object.values(v).every((x) => x === ''), `${id} 자리 값은 빈 값뿐`);
  }
  assert.deepEqual(Object.keys(JSON.parse(secrets.AnthropicApiKeySecret.Properties.SecretString)), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(Object.keys(JSON.parse(secrets.ManualSecret.Properties.SecretString)).sort(), ['BASIC_AUTH', 'SMTP_PASS', 'SMTP_USER']);
  // user data는 비밀을 참조하지 않는다. 인스턴스는 서비스 시작 때 스크립트로 읽는다.
  const ud = JSON.stringify(userData);
  for (const id of Object.keys(secrets)) assert.ok(!ud.includes(`"${id}"`) && !ud.includes(`\${${id}}`), id);
  assert.ok(!/ANTHROPIC_API_KEY|SecretString/.test(ud));
  // 모델은 기존 anthropic provider 기본값과 같다
  const def = fs.readFileSync(path.join(__dirname, '..', 'server', 'llm', 'anthropic.js'), 'utf8').match(/ANTHROPIC_MODEL \|\| '([^']+)'/)[1];
  assert.equal(T.Parameters.AnthropicModel.Default, def);
  assert.match(envScript, /'LLM_PROVIDER': 'anthropic'/);
  assert.match(envScript, /secret\(S\['apiKey'\]\)/);
  assert.deepEqual(init['/etc/cs-agent/stack.json'].content.apiKey, { Ref: 'AnthropicApiKeySecret' });
});

test('E8: 크기·Description·도구 표지 없음·ConfigurationSet 없음', () => {
  assert.ok(Buffer.byteLength(RAW) < 51200, `${Buffer.byteLength(RAW)} bytes`);
  assert.ok(Buffer.byteLength(T.Description) <= 1024);
  assert.ok(!RAW.includes('AWSToolsMetrics'));
  assert.equal(ofType('AWS::SES::ConfigurationSet').length, 0);
  for (const id of ['Instance', 'RawMailBucket', 'InstanceRole', 'InstanceSecurityGroup', 'DataVolume', 'ManualSecret', 'AnthropicApiKeySecret', 'DeadLetterQueue']) {
    assert.ok(R[id].Metadata['com.aws.cloudformation.Context'].why, `${id} why`);
  }
});

test('E9: 시작 템플릿 없음, user data는 바뀌지 않는 이름만·30줄 이하, 바뀌는 설정은 SSM 파라미터에만', () => {
  assert.equal(ofType('AWS::EC2::LaunchTemplate').length, 0);
  assert.equal(instance.Properties.LaunchTemplate, undefined);
  const lines = userData['Fn::Join'][1];
  assert.equal(userData['Fn::Join'][0], '\n');
  assert.ok(lines.length <= 30, `${lines.length}줄`);
  const allowed = new Set(['AWS::StackName', 'AWS::Region', ...Object.keys(R)]);
  for (const s of subs(userData)) for (const n of subNames(s)) assert.ok(allowed.has(n), n);
  const ud = text(userData);
  assert.match(ud, /cfn-init -v -s \$\{AWS::StackName\} -r Instance --region \$\{AWS::Region\}/);
  assert.ok(!/--role|cfn-hup|ExecStart|docker run/.test(ud), '스크립트 본문은 Init에만');
  for (const p of ['MailMode', 'ChannelMap', 'ImageTag', 'ShadowChannels', 'AdminUsers', 'AnthropicModel', 'SmtpFrom', 'MailAllowedDomains', 'LlmDailyBudget']) {
    const users = Object.entries(R).filter(([, r]) => subs(r).some((s) => subNames(s).includes(p)) || JSON.stringify(r).includes(`{"Ref":"${p}"}`)).map(([id]) => id);
    assert.deepEqual(users, ['ConfigParameter'], p);
  }
  assert.equal(R.ConfigParameter.Properties.Type, 'String');
});

test('E10: AmiId는 기본값 없는 AWS::EC2::Image::Id', () => {
  assert.equal(T.Parameters.AmiId.Type, 'AWS::EC2::Image::Id');
  assert.equal(T.Parameters.AmiId.Default, undefined);
  assert.ok(refTo(instance.Properties.ImageId, 'AmiId'));
});

test('E11: 미러 도메인 identity, EC2 자동 복구 경보', () => {
  const ids = ofType('AWS::SES::EmailIdentity').map(([, r]) => r.Properties.EmailIdentity.Ref).sort();
  assert.deepEqual(ids, ['MailDomain', 'MirrorDomain']);
  const rec = ofType('AWS::CloudWatch::Alarm').find(([, a]) => a.Properties.MetricName === 'StatusCheckFailed_System')[1].Properties;
  assert.ok(rec.AlarmActions.some((a) => /:automate:\$\{AWS::Region\}:ec2:recover$/.test(a['Fn::Sub'] || '')));
  assert.ok(refTo(rec.Dimensions[0].Value, 'Instance'));
});

test('E12: 시작 스크립트 — flock, 세 키 검사, 임시 파일 + rename, nginx reload-or-restart, 로컬 이미지 허용', () => {
  assert.equal(init['/usr/local/bin/cs-agent-env'].mode, '000700');
  assert.match(envScript, /fcntl\.flock\(lock, fcntl\.LOCK_EX\)/);
  assert.match(envScript, /\['MAIL_PROVIDER', 'LLM_PROVIDER', 'HOST'\]/);
  assert.match(envScript, /os\.replace\(tmp, path\)/);
  assert.match(envScript, /'reload-or-restart', 'nginx'/);
  assert.match(envScript, /'docker', 'image', 'inspect'/);
  assert.match(envScript, /'HOST': '127\.0\.0\.1'/);
  assert.match(envScript, /MAIL_PROVIDER='mock', ALLOW_MOCK_MAIL='1', SES_MODE='mirror'/);
  for (const name of ['cs-agent', 'cs-inbound']) {
    const u = text(init[`/etc/systemd/system/${name}.service`].content);
    assert.match(u, /^TimeoutStartSec=300$/m, name);
    assert.match(u, /^ExecStartPre=\/usr\/local\/bin\/cs-agent-env$/m, name);
    assert.match(u, /^Restart=on-failure$/m, name);
    assert.match(u, /^StartLimitIntervalSec=0$/m, name);
    assert.match(u, /--network host --env-file \/etc\/cs-agent\/app\.env /, name);
    assert.match(u, /--log-driver awslogs /, name);
  }
  assert.match(text(init['/etc/systemd/system/cs-agent.service'].content), /^RequiresMountsFor=\/data$/m, '볼륨이 없으면 루트 디스크에 새 DB를 만들지 않는다');
});
