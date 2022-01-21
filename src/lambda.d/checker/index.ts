import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand, AttributeValue } from '@aws-sdk/client-dynamodb';
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

export const handler: ContestCheckEventHandler = async (para, _context)=> {
  logger.debug(`Receiving contest checking event ${JSON.stringify(para, null, 2)}.`);

  var statusCode = 200;
  var body;
  
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
      if (response.Item) {
        const expiredTime = response.Item.ExpiredTimeInMill.N ?? -1;
        const currentTime = new Date().getTime();
        if (currentTime <= expiredTime) {
          const contestResp = await client.send(new GetItemCommand({
            TableName: process.env.TABLE,
            Key: {
              pk: {
                S: `${event.eventId}-${para.requestContext.accountId}`,
              },
            },
            ProjectionExpression: 'ContestStatus, Award',
          }));
          var contestRt: string | undefined;
          var award: string | undefined;
          if (contestResp.Item && contestResp.Item.ContestStatus.S == PASS) {
            contestRt = PASS;
            award = contestResp.Item.Award.S!;
          }
          
          if (!contestRt) {
            contestRt = FAIL;
            award = '09870';
            contestRt = PASS;
            
            var updateExpression = 'Set ContestStatus = :status, UpdatedTime = :time, Nickname = :name, ContestRt = :rt';
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
            if (award) {
              updateExpression += `, Award = :award`;
              const value: AttributeValue = {
                S: award,
              };
              const key: string = ':award';
              expressionAttributeValues[`${key}`] = value;
            }
            if (contestResp.Item) {
              const key: string = ':fail';
              expressionAttributeValues[key] = {
                S: FAIL
              };
            }
            const updateParams = {
              TableName: process.env.TABLE,
              Key: {
                pk: {
                  S: `${event.eventId}-${para.requestContext.accountId}`,
                },
              },
              UpdateExpression: updateExpression,
              ExpressionAttributeValues: expressionAttributeValues,
              ConditionExpression: contestResp.Item ? 'ContestStatus = :fail' : 'attribute_not_exists(ContestStatus)',
              ReturnValues: 'NONE',
            };
            
            logger.debug(`UpdateItemCommand is ${JSON.stringify(updateParams, null, 2)}`);
            await client.send(new UpdateItemCommand(updateParams));
            
            logger.debug(`Recorded the result. eventId: ${event.eventId}, account: ${para.requestContext.accountId}, award: ${award}, result: ${event.result}`);
          }
          
          if (PASS === contestRt)
            body = `Conguraltion! Your award is ${award}`;
          else
            body = 'Your challenge is failed. You CAN TRY AGAIN!!!';
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
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
  logger.debug(`response result is ${JSON.stringify(result, null, 2)}`);

  return result;
};