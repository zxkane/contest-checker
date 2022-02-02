import * as fs from 'fs';
import { TextEncoder, TextDecoder } from 'util';
import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient, GetItemCommand, AttributeValue, TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { APIGatewayProxyHandler } from 'aws-lambda';

const logger = new Logger({
  logLevel: 'DEBUG',
});
export type ContestCheckEventHandler = APIGatewayProxyHandler;

export interface ContestCheckEvent {
  eventId: string;
  nickname: string;
  result: string;
}

export interface ContestCheckResult {
  result: 'pass' | 'fail';
  award: any;
}

const config = {
  region: process.env.AWS_REGION,
};
const ddb = new DynamoDBClient(config);
const sts = new STSClient(config);

const decode = (str: string):string => Buffer.from(str, 'base64').toString('utf-8');
const PREFIX = 'event-';
const PASS = 'pass';
const FAIL = 'fail';
const OUT_OF_STOCK = 'out_of_stock';
const BANNED = 'banned';
const AWARD = fs.readFileSync('./award.txt', 'utf8');

/**
 * Table schema,
  {
    "N": "aaa", # nickname
    "UT": 1642828946940, # UpdatedTime
    "CR": "111sss", # ContestResult
    "pk": "20220101-630794479242", # partition key -- (<eventid>-<account>)
    "CS": "pass", # ContestStatus
    "AC": "09870" # AwardCode
    "ATS": 1 # the total attempts of submission
  }
  {
    "pk": "event-20220101", # partition key -- (event-<eventid>)
    "Awards": [ # awards
      "EOEJO231",
      "KJ239DSLD",
      "LDSJFL202",
      "LDSJFLS22",
      "LSJLKF290",
      "SDLFJLSKFJ",
      "SLKJFD02"
    ],
    "ExpiredTimeInMill": 1643644799000, # expired time in millionseconds
    "CheckerARN": "arn:aws:lambda:ap-southeast-1:<account-id>:function:<function-name>", # Lambda arn of checker
    "CheckerRole": "arn:aws:iam::<account-id>:role/role-name", # IAM role to invoke Lambda checker
  }
 */
export const handler: ContestCheckEventHandler = async (para, _context)=> {
  logger.debug(`Receiving contest checking event ${JSON.stringify(para, null, 2)}.`);

  var statusCode = 200;
  var body: string;

  if (para.body) {
    const requestBody = para.isBase64Encoded ? decode(para.body) : para.body;
    var event;
    try {
      event = JSON.parse(requestBody) as ContestCheckEvent;
    } catch (e) {
      statusCode = 400;
      body = 'Invalid request. eventId & nickname & result are required';
      logger.warn(`Given request is invalid. account: ${para.requestContext.accountId}`, e);
    }
    if (event) {
      const command = new GetItemCommand({
        TableName: process.env.TABLE,
        Key: {
          pk: {
            S: `${PREFIX}${event.eventId}`,
          },
        },
      });
      const response = await ddb.send(command);
      const theEvent = response.Item;
      if (theEvent) {
        const expiredTime = theEvent.ExpiredTimeInMill.N ?? -1;
        const currentTime = new Date().getTime();
        if (currentTime <= expiredTime) {
          const contestResp = await ddb.send(new GetItemCommand({
            TableName: process.env.TABLE,
            Key: {
              pk: {
                S: `${event.eventId}-${para.requestContext.accountId}`,
              },
            },
            ProjectionExpression: 'CS, AC',
          }));
          logger.debug(`get existing submission ${JSON.stringify(contestResp.Item)}`);
          var contestRt: string | undefined;
          var awardCode: string | undefined;
          if (contestResp.Item) {
            switch (contestResp.Item.CS.S) {
              case PASS:
                contestRt = PASS;
                awardCode = contestResp.Item.AC.S!;
                break;
              case BANNED:
                contestRt = BANNED;
                break;
            }
          }

          if (!contestRt) { // not passed and awarded
            contestRt = FAIL;

            const checkerArn = theEvent.CheckerARN.S;
            const checkerRole = theEvent.CheckerRole.S;
            if (checkerArn) {
              var newConfig: {} = {
                ...config,
              };
              if (checkerRole) {
                const assumeCmd = new AssumeRoleCommand({
                  RoleArn: checkerRole,
                  RoleSessionName: _context.awsRequestId,
                  ExternalId: 'contest',
                });
                const token = await sts.send(assumeCmd);
                newConfig = {
                  ...config,
                  credentials: {
                    accessKeyId: token.Credentials?.AccessKeyId,
                    secretAccessKey: token.Credentials?.SecretAccessKey,
                    sessionToken: token.Credentials?.SessionToken,
                  },
                };
              }
              const lambda = new LambdaClient(newConfig);
              const checkCmd = new InvokeCommand({
                FunctionName: checkerArn,
                InvocationType: 'RequestResponse',
                Payload: new TextEncoder().encode(JSON.stringify({
                  content: event.result,
                })),
              });
              const checkResp = await lambda.send(checkCmd);
              if (checkResp.StatusCode == 200 && !checkResp.FunctionError) {
                const resp = new TextDecoder('utf-8').decode(checkResp.Payload);
                logger.debug(`got checker result ${resp}`);
                contestRt = (JSON.parse(resp) as ContestCheckResult).result;
              } else {
                logger.error(`the checker failed to check content ${event.result} with error ${checkResp.FunctionError}.`);
                throw new Error('checker failed');
              }
            }

            if (contestRt == PASS) {
              const awardsInStock = theEvent.Awards?.SS;
              if (awardsInStock && awardsInStock.length > 0) {
                awardCode = awardsInStock[Math.floor(Math.random() * awardsInStock.length)];
              } else {contestRt = OUT_OF_STOCK;}
            }
            var updateExpression = 'ADD ATS :n SET CS = :status, UT = :time, N = :name, CR = :rt';
            const expressionAttributeValues: {[k: string]: AttributeValue} = {
              ':status': {
                S: contestRt,
              },
              ':time': {
                N: new Date().getTime().toString(),
              },
              ':name': {
                S: event.nickname,
              },
              ':rt': {
                S: event.result,
              },
              ':n': {
                N: '1',
              },
            };
            switch (contestRt) {
              case PASS:
                updateExpression += ', AC = :award';
                expressionAttributeValues[':award'] = {
                  S: awardCode!,
                };
                expressionAttributeValues[':pass'] = {
                  S: PASS,
                };
                const recordContestResult = {
                  TableName: process.env.TABLE,
                  Key: {
                    pk: {
                      S: `${event.eventId}-${para.requestContext.accountId}`,
                    },
                  },
                  UpdateExpression: updateExpression,
                  ExpressionAttributeValues: expressionAttributeValues,
                  ConditionExpression: 'NOT CS = :pass or attribute_not_exists(CS)',
                  ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
                };

                logger.debug(`recordContestResult is ${JSON.stringify(recordContestResult, null, 2)}`);

                const deductionInventory = {
                  TableName: process.env.TABLE,
                  Key: {
                    pk: {
                      S: theEvent.pk.S!,
                    },
                  },
                  UpdateExpression: 'DELETE Awards :a',
                  ExpressionAttributeValues: {
                    ':a': {
                      SS: [awardCode!],
                    },
                    ':b': {
                      S: awardCode!,
                    },
                  },
                  ConditionExpression: 'contains(Awards, :b)',
                  ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
                };
                const recTranscation = new TransactWriteItemsCommand({
                  TransactItems: [
                    {
                      Update: recordContestResult,
                    },
                    {
                      Update: deductionInventory,
                    },
                  ],
                  ReturnConsumedCapacity: 'TOTAL',
                  ClientRequestToken: para.requestContext.requestId,
                });
                const recResp = await ddb.send(recTranscation);

                logger.debug(`Recorded the contest result. eventId: ${event.eventId}, 
                  account: ${para.requestContext.accountId}, contestStatus: ${contestRt}, 
                  result: ${event.result}, totalConsumedCapability: ${recResp.ConsumedCapacity!.map(c => c.WriteCapacityUnits!).reduce((acc, value) => acc + value), 0}`);
                break;
              case OUT_OF_STOCK:
              case FAIL:
                expressionAttributeValues[':pass'] = {
                  S: PASS,
                };

                const recordNonAwarded = await ddb.send(new UpdateItemCommand({
                  TableName: process.env.TABLE,
                  Key: {
                    pk: {
                      S: `${event.eventId}-${para.requestContext.accountId}`,
                    },
                  },
                  UpdateExpression: updateExpression,
                  ExpressionAttributeValues: expressionAttributeValues,
                  ConditionExpression: 'attribute_not_exists(CS) OR NOT CS = :pass',
                  ReturnValues: 'ALL_NEW',
                  ReturnConsumedCapacity: 'TOTAL',
                }));
                logger.warn(`The contest award is ${contestRt} and recorded the request. eventId: ${event.eventId}, 
                  account: ${para.requestContext.accountId}, contestStatus: ${contestRt}, result: ${event.result},
                  consumedCapacity: ${recordNonAwarded.ConsumedCapacity?.CapacityUnits}`);
            }
          }

          switch (contestRt) {
            case PASS:
              body = `${AWARD}\n\t您好棒！AI 被您的祝福打败了。恭喜获得星巴克电子兑换码: ${awardCode}`;
              break;
            case FAIL:
            case BANNED:
              body = `${AWARD}\n\t很遗憾，AI 觉得您的祝福不够好。您可以再次提交尝试。`;
              break;
            case OUT_OF_STOCK:
              body = `${AWARD}\n\t感谢您的参与。我们的奖品目前缺货中。奖品每日将不定期补货。`;
              break;
          }
        } else {
          statusCode = 404;
          body = `the given event ${event.eventId} is expired.`;
          logger.info(`Given event is expired. eventId: ${event.eventId}, account: ${para.requestContext.accountId}`);
        }
      } else {
        statusCode = 404;
        body = `the given event ${event.eventId} is not found.`;
        logger.info(`Given event is not found. eventId: ${event.eventId}, account: ${para.requestContext.accountId}`);
      }
    }
  } else {
    statusCode = 400;
    body = 'body is required in json format';
  }

  const result = {
    statusCode,
    body: body!,
    isBase64Encoded: false,
  };
  logger.debug(`response result is ${JSON.stringify(result, null, 2)}`);

  return result;
};