import * as path from 'path';
import { App, Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { BackupPlan, BackupResource } from 'aws-cdk-lib/aws-backup';
import { Table, AttributeType, TableEncryption, BillingMode, StreamViewType } from 'aws-cdk-lib/aws-dynamodb';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture, Tracing, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class ContestCheckerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // define resources here...
    const eventIndexName = 'event';
    const contestTable = new Table(this, 'ContestTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
      contributorInsightsEnabled: true,
      encryption: TableEncryption.AWS_MANAGED,
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: StreamViewType.NEW_IMAGE,
    });

    const topic = new Topic(this, 'SubmissionNotifyTopic', {
      displayName: 'Contest Sbumission Notification subscription topic',
    });
    const deadLetterQueue = new Queue(this, 'deadLetterQueue');

    const ddbStreamFunc = new NodejsFunction(this, 'ddb-stream-processing', {
      entry: path.join(__dirname, './lambda.d/submission-processor/index.ts'),
      handler: 'handler',
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 128,
      runtime: Runtime.NODEJS_14_X,
      tracing: Tracing.ACTIVE,
      environment: {
        TOPIC_ARN: topic.topicArn,
      },
    });
    topic.grantPublish(ddbStreamFunc);
    ddbStreamFunc.addEventSource(new DynamoEventSource(contestTable, {
      startingPosition: StartingPosition.TRIM_HORIZON,
      batchSize: 5,
      bisectBatchOnError: true,
      onFailure: new SqsDlq(deadLetterQueue),
      retryAttempts: 10,
    }));

    const plan = BackupPlan.dailyWeeklyMonthly5YearRetention(this, 'DynamodbPlan');
    plan.addSelection('Selection', {
      resources: [
        BackupResource.fromDynamoDbTable(contestTable), // A DynamoDB table
      ],
    });

    const checkerFunc = new NodejsFunction(this, 'checker', {
      entry: path.join(__dirname, './lambda.d/checker/index.ts'),
      handler: 'handler',
      bundling: {
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [
              `cp ${inputDir}/src/lambda.d/checker/award.txt ${outputDir}`,
            ];
          },
          afterBundling(_inputDir: string, _outputDir: string): string[] {
            return [];
          },
          beforeInstall() {
            return [];
          },
        },
      },
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 128,
      runtime: Runtime.NODEJS_14_X,
      tracing: Tracing.ACTIVE,
      environment: {
        TABLE: contestTable.tableName,
        EVENT_INDEX_NAME: eventIndexName,
      },
      reservedConcurrentExecutions: 10,
    });
    contestTable.grantReadWriteData(checkerFunc);
    checkerFunc.addPermission('api-gateway', {
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
    });

    new CfnOutput(this, 'CheckFuncArn', {
      value: checkerFunc.functionArn,
      description: 'arn of checker func',
    });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new ContestCheckerStack(app, 'contest-checker', { env: devEnv });

app.synth();