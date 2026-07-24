import { IsString, IsOptional, IsInt, Min, Max, Matches, MaxLength, IsArray, ArrayMaxSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';

export class SendTextStatusDto {
  @ApiProperty({ description: 'Status text body.', example: 'Out for delivery 📦', maxLength: 4096 })
  @IsString()
  @MaxLength(4096)
  text: string;

  @ApiPropertyOptional({ description: 'Background color (hex).', example: '#25D366' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'backgroundColor must be a hex color (e.g., #25D366)' })
  backgroundColor?: string;

  @ApiPropertyOptional({ description: 'Font family index (0–5).', example: 0, minimum: 0, maximum: 5 })
  @ToStrictNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  font?: number;

  @ApiPropertyOptional({
    description:
      'Recipient JIDs (0–256). WhatsApp Status is not posted to a group — use @c.us or @lid individuals. ' +
      'Required on the Baileys engine (it posts to exactly this allow-list); ignored by whatsapp-web.js, ' +
      "which broadcasts to the account's status-privacy audience — omit it there.",
    type: String,
    isArray: true,
    example: ['628123456789@c.us'],
    maxItems: 256,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients?: string[];
}
