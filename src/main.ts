import * as path from 'path';
import { App, Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { RestApi, MethodLoggingLevel, LambdaIntegration, JsonSchemaType } from 'aws-cdk-lib/aws-apigateway';
import { Table, AttributeType, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
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
    });
    contestTable.grantReadWriteData(checkerFunc);
    checkerFunc.addPermission('api-gateway', {
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
    });

    const authorizeFunc = new NodejsFunction(this, 'authorization', {
      entry: path.join(__dirname, './lambda.d/authorization/index.ts'),
      handler: 'handler',
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 128,
      runtime: Runtime.NODEJS_14_X,
      tracing: Tracing.ACTIVE,
      environment: {
        TABLE: contestTable.tableName,
        CHECKER_FUNC_ARN: checkerFunc.functionArn,
      },
    });
    contestTable.grantReadWriteData(authorizeFunc);
    const api = new RestApi(this, 'authorize-api', {
      deployOptions: {
        stageName: 'v1',
        loggingLevel: MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
    });

    const authorRequestModel = api.addModel('AuthorizationRequestModel', {
      schema: {
        type: JsonSchemaType.OBJECT,
        properties: {
          account: {
            type: JsonSchemaType.STRING,
          },
          eventId: {
            type: JsonSchemaType.STRING,
          },
          nickname: {
            type: JsonSchemaType.STRING,
          },
        },
        required: ['account', 'eventId', 'nickname'],
      },
    });

    const authorize = api.root.addResource('authorize');
    authorize.addMethod('POST', new LambdaIntegration(authorizeFunc), {
      requestModels: {
        'application/json': authorRequestModel,
      },
      requestValidatorOptions: {
        validateRequestBody: true,
      },
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