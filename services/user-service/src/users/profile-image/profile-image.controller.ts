import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { userErrorResponses, userIdentityHeader } from '../../http.openapi.js';
import { parseUserId } from '../../user-id.js';
import { ProfileImageService } from './profile-image.service.js';
import {
  ProfileImageCompleteResult,
  ProfileImageUploadBody,
  ProfileImageUploadResult,
  ProfileImageUrlResult,
} from './profile-image.openapi.js';

@ApiTags('User profile images')
@Controller('api/v1/users')
@userIdentityHeader()
@userErrorResponses(
  [400, 'Invalid input.'],
  [401, 'Invalid Gateway credentials.'],
  [403, 'Active account required.'],
  [404, 'User/upload unavailable or not owned.'],
  [503, 'Storage disabled or unavailable.'],
)
export class ProfileImageController {
  constructor(private readonly images: ProfileImageService) {}
  @Post('me/profile-image/uploads')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Create a profile image upload',
    description:
      'JPEG/PNG/WebP, at most 2MiB; PUT expires after five minutes. Only server-generated keys are accepted.',
  })
  @ApiBody({ type: ProfileImageUploadBody })
  @ApiResponse({ status: 201, type: ProfileImageUploadResult })
  initiate(@Headers('x-user-id') actor: unknown, @Body() body: unknown) {
    return this.images.initiate(actorId(actor), body);
  }
  @Post('me/profile-image/uploads/:uploadId/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Verify and apply profile image',
    description:
      'Idempotent per upload. Distinct uploads serialize on the user row; last application commit wins. Replaying an applied upload never restores it. GET /users/me after success.',
  })
  @ApiParam({ name: 'uploadId', format: 'uuid' })
  @ApiResponse({ status: 200, type: ProfileImageCompleteResult })
  @userErrorResponses(
    [409, 'Upload expired.'],
    [422, 'Missing file or size/MIME/checksum/signature mismatch.'],
  )
  complete(
    @Headers('x-user-id') actor: unknown,
    @Param('uploadId') id: string,
    @Headers('x-request-id') requestId: unknown,
  ) {
    return this.images.complete(
      actorId(actor),
      id,
      typeof requestId === 'string' && requestId.trim() ? requestId : undefined,
    );
  }
  @Get('me/profile-image/url')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read current own profile image URL',
    description:
      'Signed GET expires after five minutes; absent image returns 200 with null key, url and expiresAt.',
  })
  @ApiResponse({ status: 200, type: ProfileImageUrlResult })
  readMe(@Headers('x-user-id') actor: unknown) {
    return this.images.read(actorId(actor));
  }

  @Get(':userId/profile-image/url')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read another user profile image URL',
    description:
      'Authenticated ACTIVE requester and ACTIVE onboarded target required. Either direction of block returns 404. URL is a bearer capability for five minutes; an already issued URL cannot be revoked by blocking.',
  })
  @ApiParam({
    name: 'userId',
    schema: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
  })
  @ApiResponse({ status: 200, type: ProfileImageUrlResult })
  readUser(
    @Headers('x-user-id') actor: unknown,
    @Param('userId') target: unknown,
  ) {
    const id = parseUserId(target);
    if (!id) throw new BadRequestException('Invalid userId');
    return this.images.read(actorId(actor), id);
  }
}
function actorId(value: unknown) {
  const id = parseUserId(value);
  if (!id)
    throw new UnauthorizedException('Invalid authentication credentials');
  return id;
}
