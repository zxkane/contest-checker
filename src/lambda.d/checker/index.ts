import * as fs from 'fs';
import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient, GetItemCommand, AttributeValue, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
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

const client = new DynamoDBClient({
  region: process.env.AWS_REGION,
});

const decode = (str: string):string => Buffer.from(str, 'base64').toString('binary');
const PREFIX = 'event-';
const PASS = 'pass';
const FAIL = 'fail';
const OUT_OF_STOCK = 'out_of_stock';
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
    "ExpiredTimeInMill": 1643644799000 # expired time in millionseconds
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
      const response = await client.send(command);
      const theEvent = response.Item;
      if (theEvent) {
        const expiredTime = theEvent.ExpiredTimeInMill.N ?? -1;
        const currentTime = new Date().getTime();
        if (currentTime <= expiredTime) {
          const contestResp = await client.send(new GetItemCommand({
            TableName: process.env.TABLE,
            Key: {
              pk: {
                S: `${event.eventId}-${para.requestContext.accountId}`,
              },
            },
            ProjectionExpression: 'CS, AC',
          }));
          var contestRt: string | undefined;
          var awardCode: string | undefined;
          if (contestResp.Item && contestResp.Item.CS.S == PASS) {
            contestRt = PASS;
            awardCode = contestResp.Item.AC.S!;
          }

          if (!contestRt) {
            // TODO check the contest result
            contestRt = FAIL;
            contestRt = PASS;

            if (contestRt === PASS) {
              const awardsInStock = theEvent.Awards?.SS;
              if (awardsInStock && awardsInStock.length > 0) {
                awardCode = awardsInStock[Math.floor(Math.random() * awardsInStock.length)];
                var updateExpression = 'Set CS = :status, UT = :time, N = :name, CR = :rt';
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
                };
                if (awardCode) {
                  updateExpression += ', AC = :award';
                  const value: AttributeValue = {
                    S: awardCode,
                  };
                  const key: string = ':award';
                  expressionAttributeValues[`${key}`] = value;
                }
                if (contestResp.Item) {
                  const key: string = ':fail';
                  expressionAttributeValues[key] = {
                    S: FAIL,
                  };
                }
                const recordContestResult = {
                  TableName: process.env.TABLE,
                  Key: {
                    pk: {
                      S: `${event.eventId}-${para.requestContext.accountId}`,
                    },
                  },
                  UpdateExpression: updateExpression,
                  ExpressionAttributeValues: expressionAttributeValues,
                  ConditionExpression: contestResp.Item ? 'CS = :fail' : 'attribute_not_exists(CS)',
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
                      SS: [awardCode],
                    },
                    ':b': {
                      S: awardCode,
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
                const recResp = await client.send(recTranscation);

                logger.debug(`Recorded the contest result. eventId: ${event.eventId}, 
                  account: ${para.requestContext.accountId}, contestStatus: ${contestRt}, 
                  result: ${event.result}, totalConsumedCapability: ${recResp.ConsumedCapacity!.map(c => c.WriteCapacityUnits!).reduce((acc, value) => acc + value), 0}`);
              } else {
                contestRt = OUT_OF_STOCK;
                logger.warn(`The contest award is out of stock. eventId: ${event.eventId}, 
                  account: ${para.requestContext.accountId}, contestStatus: ${contestRt}, result: ${event.result}`);
              }
            }
          }

          switch (contestRt) {
            case PASS:
              body = `${AWARD}\n\t感谢您的参与，恭喜获得星巴克电子兑换码: ${awardCode}`;
              break;
            case FAIL:
              body = `${AWARD}\n\t很抱歉，您没有获得奖励。您可以再次提交尝试。`;
              break;
            case OUT_OF_STOCK:
              body = `${AWARD}\n\t很抱歉，我们的奖品已兑完，感谢您的参与。`;
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