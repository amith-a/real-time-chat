import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import * as RealTimeChat from '../lib/real-time-chat-stack';

test('stack can be synthesized', () => {
	const app = new cdk.App();
	const stack = new RealTimeChat.RealTimeChatStack(app, 'TestStack');

	const template = Template.fromStack(stack);

	expect(template).toBeDefined();
});
