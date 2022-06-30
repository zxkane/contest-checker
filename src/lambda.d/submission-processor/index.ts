import { Logger } from '@aws-lambda-powertools/logger';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBStreamHandler } from 'aws-lambda';

const logger = new Logger({
  logLevel: 'INFO',
});

const client = new SNSClient({
  region: process.env.AWS_REGION,
});

export const handler: DynamoDBStreamHandler = async (para, _context)=> {
  logger.debug('Receiving changed ddb records.');

  for (const record of para.Records) {
    logger.debug(`Processing new submission ${JSON.stringify(record.dynamodb?.NewImage, null, 2)}`);
    switch (record.eventName) {
      case 'INSERT':
      case 'MODIFY':
        switch (record.dynamodb?.NewImage?.CS?.S) {
          case 'pass':
          case 'out_of_stock':
            const date = new Date(Number(record.dynamodb?.NewImage?.UT.N!)).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' });
            const command = new PublishCommand({
              TopicArn: process.env.TOPIC_ARN,
              Message: `the submission duration/score is ${record.dynamodb?.NewImage?.durationInMS?.S}/${record.dynamodb?.NewImage?.score?.S} at ${date}`,
              Subject: `received submission with result ${record.dynamodb?.NewImage?.CS.S} from ${record.dynamodb?.NewImage?.NS?.SS![0]}`,
            });
            await client.send(command);
            logger.info(`send notification ${JSON.stringify(command, null, 2)} 
                for ${record.dynamodb?.NewImage?.pk?.S} to sns topic`);
            break;
          default:
            logger.debug(`ignore the failure/non submission ${JSON.stringify(record.dynamodb, null, 2)}`);
        }
        break;
      default:
        logger.debug(`ignore the non-upsert record ${record.eventID}`);
    }
  }
};