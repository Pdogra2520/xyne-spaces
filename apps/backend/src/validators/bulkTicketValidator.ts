import Joi from 'joi';
import { MAX_BULK_TICKETS } from '@xyne/shared';

const etaSchema = Joi.date().allow(null).messages({
  'date.base': 'ETA must be a valid date',
  'any.invalid': 'ETA must be a valid date or null',
});

const bulkTicketSchema = Joi.object({
  title: Joi.string().trim().min(1).max(500).required(),
  description: Joi.string().trim().allow('').max(4000).optional(),
  channelId: Joi.string().required(),
  boardId: Joi.string().required(),
  priority: Joi.string().valid('LOW', 'MEDIUM', 'HIGH', 'CRITICAL').optional(),
  statusV2: Joi.string().valid('TODO', 'STARTED', 'PAUSED', 'CANCELLED', 'COMPLETED').optional(),
  eta: etaSchema.optional(),
  assignedTo: Joi.string().allow(null).optional(),
  userGroupId: Joi.string().allow(null).optional(),
  ticketType: Joi.string().optional(),
  dynamicFields: Joi.object()
    .pattern(Joi.string(), Joi.alternatives(Joi.string().allow(''), Joi.array().items(Joi.string())))
    .optional(),
  clientRowId: Joi.string().optional(),
  parentClientRowId: Joi.string().optional(),
  parentTicketId: Joi.string().optional(),
});

export const bulkTicketSchemaValidator = Joi.object({
  tickets: Joi.array().items(bulkTicketSchema).min(1).max(MAX_BULK_TICKETS).required(),
  draftTarget: Joi.object({
    channelId: Joi.string().required(),
    conversationId: Joi.string().allow(null).optional(),
  }).optional(),
  draftId: Joi.string().optional(),
  replaceDraft: Joi.boolean().optional(),
  sourceConversationId: Joi.string().optional(),
  fromTicketsTab: Joi.boolean().optional(),
});
