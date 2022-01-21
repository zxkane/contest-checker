import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';

export type ContestCheckEventHandler = APIGatewayProxyHandler;

export interface AuthorizationResult {
  arn: string;
}

export const handler: ContestCheckEventHandler = async (para, _context)=> {
  console.info(`Receiving authorzization request event ${JSON.stringify(para, null, 2)}.`);

  const result: APIGatewayProxyResult = {
    statusCode: 200,
    body: JSON.stringify({
      arn: 'arn:aws:xxxxx:111',
    }),
    isBase64Encoded: false,
  };
  return result;
};