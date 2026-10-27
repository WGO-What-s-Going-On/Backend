import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiUnprocessableEntityResponse,
  ApiServiceUnavailableResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { userId } from '../presentation/post.input.js';
import { PostErrorFilter } from '../presentation/post-error.filter.js';
import { MediaService } from './media.service.js';
import {
  MediaUploadBody,
  MediaUploadResponse,
  MediaStatusResponse,
} from './media.openapi.js';

@Controller('api/v1/posts/media/uploads')
@ApiTags('Post media')
@ApiHeader({
  name: 'X-User-Id',
  description:
    '로컬·테스트 전용. 공개 운영 업로드는 기존 인증 정책에 따라 503.',
})
@ApiBadRequestResponse({ description: '입력 또는 mediaId 형식 오류' })
@ApiForbiddenResponse({ description: '로컬 사용자 헤더 누락/오류' })
@ApiServiceUnavailableResponse({
  description: '운영 인증 미연동, 미디어 비활성 또는 S3 장애',
})
@UseFilters(PostErrorFilter)
export class MediaController {
  constructor(private readonly media: MediaService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '이미지/동영상 업로드 URL 발급',
    description:
      'S3 업로드 후 complete를 호출하고 게시물/댓글에 mediaId를 전달합니다. URL 및 헤더를 로그에 기록하지 마세요.',
  })
  @ApiBody({ type: MediaUploadBody })
  @ApiCreatedResponse({ type: MediaUploadResponse })
  initiate(
    @Headers('x-user-id') actor: string | undefined,
    @Body() body: unknown,
  ) {
    return this.media.initiate(userId(actor), body);
  }
  @ApiNotFoundResponse({ description: '없는 업로드 또는 다른 소유자' })
  @Get(':mediaId')
  @ApiOperation({ summary: '본인 업로드 상태 조회' })
  @ApiOkResponse({ type: MediaStatusResponse })
  status(
    @Headers('x-user-id') actor: string | undefined,
    @Param('mediaId') id: string,
  ) {
    return this.media.status(userId(actor), id);
  }
  @ApiNotFoundResponse({ description: '없는 업로드 또는 다른 소유자' })
  @ApiConflictResponse({ description: '취소/만료된 업로드' })
  @ApiUnprocessableEntityResponse({
    description: '파일 크기/체크섬/시그니처 검증 실패',
  })
  @Post(':mediaId/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: '업로드 검증 및 첨부 준비',
    description:
      '크기·Content-Type·SHA-256·파일 시그니처를 확인하고 브라우저가 쓸 수 없는 경로로 복사합니다.',
  })
  @ApiOkResponse({ type: MediaStatusResponse })
  complete(
    @Headers('x-user-id') actor: string | undefined,
    @Param('mediaId') id: string,
  ) {
    return this.media.complete(userId(actor), id);
  }
  @ApiNotFoundResponse({ description: '없는 업로드 또는 다른 소유자' })
  @ApiConflictResponse({ description: '이미 첨부된 파일' })
  @Delete(':mediaId')
  @HttpCode(204)
  @ApiOperation({
    summary: '미첨부 업로드 취소',
    description: '멱등 취소. S3 파일은 비동기로 정리하며 ATTACHED는 409입니다.',
  })
  @ApiNoContentResponse()
  cancel(
    @Headers('x-user-id') actor: string | undefined,
    @Param('mediaId') id: string,
  ) {
    return this.media.cancel(userId(actor), id);
  }
}
