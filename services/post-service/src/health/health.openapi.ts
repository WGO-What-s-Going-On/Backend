import { ApiProperty } from '@nestjs/swagger';

export class LivenessResponse {
  @ApiProperty({ enum: ['post-service'] }) service!: string;
  @ApiProperty({ enum: ['ok'] }) status!: string;
}
