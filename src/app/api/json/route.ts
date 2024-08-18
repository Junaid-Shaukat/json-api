import { openai } from "@/lib/openai";
import { NextRequest, NextResponse } from "next/server";
import { ZodTypeAny, z } from "zod";
import { EXAMPLE_ANSWER, EXAMPLE_PROMPT } from "./example";

const determineSchemaType = (schema: any) => {
  // {type: 'array'}

  if (!schema.hasOwnProperty("type")) {
    if (Array.isArray(schema)) {
      return "array";
    } else {
      return typeof schema; //"string", "number", "object"
    }
  }
  return schema.type;
};
``;
const jsonSchmeaToZod = (schema: any): ZodTypeAny => {
  const type = determineSchemaType(schema);

  switch (type) {
    case "string":
      return z.string().nullable();
    case "number":
      return z.number().nullable();
    case "boolean":
      return z.boolean().nullable();
    case "array":
      return z.array(jsonSchmeaToZod(schema.items)).nullable();
    case "object":
      const shape: Record<string, ZodTypeAny> = {};

      //name : {type: 'string'} ------> name:<zodSchemaForString>

      for (const key in schema) {
        if (key !== "type") {
          shape[key] = jsonSchmeaToZod(schema[key]);
        }
      }
      return z.object(shape);

    default:
      throw new Error(`Unsupported data type: ${type}`);
  }
};

export const POST = async (req: NextRequest) => {
  const body = await req.json();

  // data format
  // step 1: make sure incoming request is valid
  const genericSchema = z.object({
    data: z.string(),
    format: z.object({}).passthrough(),
  });

  // parse data

  const { data, format } = genericSchema.parse(body);

  //step 2: create a schmea form the excepted user format

  const dynamicSchema = jsonSchmeaToZod(format);

  // step 3: retry mechanism

  type PromiseExecutor<T> = (
    resolve: (value: T) => void,
    reject: (reson?: any) => void
  ) => void;

  class RetryablePromise<T> extends Promise<T> {
    static async retry<T>(
      retries: number,
      executor: PromiseExecutor<T>
    ): Promise<T> {
      return new RetryablePromise(executor).catch((error) => {
        console.error(`Retrying due to error: ${error}`);

        return retries > 0
          ? RetryablePromise.retry(retries - 1, executor)
          : RetryablePromise.reject(error);
      });
    }
  }

  const validationResult = await RetryablePromise.retry<object>(
    3,
    async (resolve, reject) => {
      try {
        //call ai

        const content = `DATA: \n"${data}"\n\n-----------\nExpected JSON format: ${JSON.stringify(
          format,
          null,
          2
        )}\n\n-----------\nValid JSON output in expected format:`;

        const res = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "assistant",
              content:
                "You are an AI that converts unstructured data into the attached JSON format. You respond with nothing but valid JSON based on the input data. Your output should DIRECTLY be valid JSON, nothing added before or after. You will begin right with the opening curly brace and end with the closing curly brace. Only if you absolutely cannot determine a field, use the value null.",
            },
            {
              role: "user",
              content: EXAMPLE_PROMPT,
            },
            {
              role: "system",
              content: EXAMPLE_ANSWER,
            },
            {
              role: "user",
              content,
            },
          ],
        });

        const text = res.choices[0].message.content
        // validate json

        const validationResult = dynamicSchema.parse(JSON.parse(text || ""));

        return resolve(validationResult);
      } catch (err) {
        reject(err);
      }
    }
  );

  return NextResponse.json(validationResult, { status: 200 });
};
