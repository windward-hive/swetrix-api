import _isEmpty from 'lodash/isEmpty'
import _isArray from 'lodash/isArray'
import _map from 'lodash/map'
import _includes from 'lodash/includes'
import _size from 'lodash/size'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import dayjsTimezone from 'dayjs/plugin/timezone'
import {
  Controller,
  Body,
  Query,
  UseGuards,
  Get,
  Post,
  Patch,
  Headers,
  BadRequestException,
  InternalServerErrorException,
  UnprocessableEntityException,
  Ip,
  ForbiddenException,
  Response,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import UAParser from 'ua-parser-js'

import { OptionalJwtAccessTokenGuard } from '../auth/guards'
import { Auth, Public } from '../auth/decorators'
import {
  AnalyticsService,
  getHeartbeatKey,
  DataType,
  getLowestPossibleTimeBucket,
} from './analytics.service'
import { VALID_PERIODS } from './decorators/validate-period.decorator'
import { CurrentUserId } from '../auth/decorators/current-user-id.decorator'
import { DEFAULT_TIMEZONE } from '../user/entities/user.entity'
import { RolesGuard } from '../auth/guards/roles.guard'
import { PageviewsDTO } from './dto/pageviews.dto'
import { EventsDTO } from './dto/events.dto'
import { GetDataDto, ChartRenderMode } from './dto/getData.dto'
import { GetFiltersDto } from './dto/get-filters.dto'
import { GetCustomEventMetadata } from './dto/get-custom-event-meta.dto'
import { GetPagePropertyMetaDto } from './dto/get-page-property-meta.dto'
import { GetUserFlowDto } from './dto/getUserFlow.dto'
import { GetFunnelsDto } from './dto/getFunnels.dto'
import { AppLoggerService } from '../logger/logger.service'
import { redis, HEARTBEAT_SID_LIFE_TIME } from '../common/constants'
import { clickhouse } from '../common/integrations/clickhouse'
import {
  checkRateLimit,
  getGeoDetails,
  getIPFromHeaders,
} from '../common/utils'
import { GetCustomEventsDto } from './dto/get-custom-events.dto'
import {
  IFunnel,
  IGetFunnel,
  IPageProperty,
  IUserFlow,
  PerfMeasure,
} from './interfaces'
import { GetSessionsDto } from './dto/get-sessions.dto'
import { GetSessionDto } from './dto/get-session.dto'
import { ErrorDTO } from './dto/error.dto'
import { GetErrorsDto } from './dto/get-errors.dto'
import { GetErrorDTO } from './dto/get-error.dto'
import { PatchStatusDTO } from './dto/patch-status.dto'
import {
  customEventTransformer,
  errorEventTransformer,
  performanceTransformer,
  trafficTransformer,
} from './utils/transformers'
import { MAX_METRICS_IN_VIEW } from '../project/dto/create-project-view.dto'
import { extensions } from './utils/ua-parser'
import { GetOverallStatsDto } from './dto/get-overall-stats.dto'

dayjs.extend(utc)
dayjs.extend(dayjsTimezone)

export const DEFAULT_MEASURE = 'median'

// Performance object validator: none of the values cannot be bigger than 1000 * 60 * 5 (5 minutes) and are >= 0
const MAX_PERFORMANCE_VALUE = 1000 * 60 * 5
const isPerformanceValid = (perf: any) => {
  return (
    perf.dns <= MAX_PERFORMANCE_VALUE &&
    perf.tls <= MAX_PERFORMANCE_VALUE &&
    perf.conn <= MAX_PERFORMANCE_VALUE &&
    perf.response <= MAX_PERFORMANCE_VALUE &&
    perf.render <= MAX_PERFORMANCE_VALUE &&
    perf.dom_load <= MAX_PERFORMANCE_VALUE &&
    perf.page_load <= MAX_PERFORMANCE_VALUE &&
    perf.ttfb <= MAX_PERFORMANCE_VALUE &&
    perf.dns >= 0 &&
    perf.tls >= 0 &&
    perf.conn >= 0 &&
    perf.response >= 0 &&
    perf.render >= 0 &&
    perf.dom_load >= 0 &&
    perf.page_load >= 0 &&
    perf.ttfb >= 0
  )
}

const getPIDsArray = (pids, pid) => {
  const pidsEmpty = _isEmpty(pids)
  const pidEmpty = _isEmpty(pid)
  if (pidsEmpty && pidEmpty)
    throw new BadRequestException(
      "An array of Project ID's (pids) or a Project ID (pid) has to be provided",
    )
  else if (!pidsEmpty && !pidEmpty)
    throw new BadRequestException(
      "Please provide either an array of Project ID's (pids) or a Project ID (pid), but not both",
    )
  else if (!pidEmpty) {
    pids = JSON.stringify([pid])
  }

  try {
    pids = JSON.parse(pids)
  } catch (e) {
    throw new UnprocessableEntityException(
      "Cannot process the provided array of Project ID's",
    )
  }

  if (!_isArray(pids)) {
    throw new UnprocessableEntityException(
      "An array of Project ID's has to be provided as a 'pids' param",
    )
  }

  return pids
}

const getEIDsArray = (eids, eid) => {
  const eidsEmpty = _isEmpty(eids)
  const eidEmpty = _isEmpty(eid)
  if (eidsEmpty && eidEmpty) {
    throw new BadRequestException(
      "An array of Error ID's (eids) or a Error ID (eid) has to be provided",
    )
  }
  if (!eidsEmpty && !eidEmpty) {
    throw new BadRequestException(
      "Please provide either an array of Error ID's (eids) or a Error ID (eid), but not both",
    )
  }

  if (!eidsEmpty) {
    return eids
  }

  return [eid]
}

// needed for serving 1x1 px GIF
const TRANSPARENT_GIF_BUFFER = Buffer.from(
  'R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=',
  'base64',
)

@ApiTags('Analytics')
@UseGuards(OptionalJwtAccessTokenGuard, RolesGuard)
@Controller(['log', 'v1/log'])
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly logger: AppLoggerService,
  ) {}

  @Get()
  @Auth([], true, true)
  async getData(
    @Query() data: GetDataDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      period,
      timeBucket,
      from,
      to,
      filters,
      timezone = DEFAULT_TIMEZONE,
      mode = ChartRenderMode.PERIODICAL,
      metrics,
    } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const parsedMetrics = this.analyticsService.parseMetrics(metrics)

    if (_size(parsedMetrics) > MAX_METRICS_IN_VIEW) {
      throw new BadRequestException(
        `The maximum number of metrics within one request is ${MAX_METRICS_IN_VIEW}`,
      )
    }

    let newTimebucket = timeBucket
    let allowedTumebucketForPeriodAll

    let diff

    if (period === 'all') {
      const res = await this.analyticsService.getTimeBucketForAllTime(
        pid,
        period,
        timezone,
      )

      diff = res.diff
      // eslint-disable-next-line prefer-destructuring
      newTimebucket = _includes(res.timeBucket, timeBucket)
        ? timeBucket
        : res.timeBucket[0]
      allowedTumebucketForPeriodAll = res.timeBucket
    }

    const [filtersQuery, filtersParams, parsedFilters, customEVFilterApplied] =
      this.analyticsService.getFiltersQuery(filters, DataType.ANALYTICS)

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFrom, groupTo, groupFromUTC, groupToUTC } =
      this.analyticsService.getGroupFromTo(
        from,
        to,
        newTimebucket,
        period,
        safeTimezone,
        diff,
      )

    let subQuery = `FROM analytics WHERE pid = {pid:FixedString(12)} ${filtersQuery} AND created BETWEEN {groupFrom:String} AND {groupTo:String}`

    if (customEVFilterApplied) {
      subQuery = `FROM customEV WHERE pid = {pid:FixedString(12)} ${filtersQuery} AND created BETWEEN {groupFrom:String} AND {groupTo:String}`
    }

    const paramsData = {
      params: {
        pid,
        groupFrom: groupFromUTC,
        groupTo: groupToUTC,
        ...filtersParams,
      },
    }

    const result = await this.analyticsService.groupByTimeBucket(
      newTimebucket,
      groupFrom,
      groupTo,
      subQuery,
      filtersQuery,
      paramsData,
      safeTimezone,
      customEVFilterApplied,
      parsedFilters,
      mode,
    )

    const customs = await this.analyticsService.getCustomEvents(
      filtersQuery,
      paramsData,
    )

    let properties: IPageProperty = {}

    if (!customEVFilterApplied) {
      properties = await this.analyticsService.getPageProperties(
        filtersQuery,
        paramsData,
      )
    }

    let meta: Awaited<ReturnType<typeof this.analyticsService.getMetaResults>>

    if (!_isEmpty(parsedMetrics)) {
      meta = await this.analyticsService.getMetaResults(
        pid,
        parsedMetrics,
        filtersQuery,
        paramsData,
        timezone,
        period,
        from,
        to,
      )
    }

    return {
      ...result,
      customs,
      properties,
      appliedFilters: parsedFilters,
      timeBucket: allowedTumebucketForPeriodAll,
      meta,
    }
  }

  @Get('funnel')
  @Auth([], true, true)
  async getFunnel(
    @Query() data: GetFunnelsDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ): Promise<IGetFunnel> {
    const {
      pid,
      period,
      from,
      to,
      timezone = DEFAULT_TIMEZONE,
      pages,
      funnelId,
    } = data
    this.analyticsService.validatePID(pid)

    const pagesArr = await this.analyticsService.getPagesArray(
      pages,
      funnelId,
      pid,
    )

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFrom, groupTo } = this.analyticsService.getGroupFromTo(
      from,
      to,
      null,
      period,
      safeTimezone,
    )

    const params = {
      pid,
      groupFrom,
      groupTo,
    }

    let funnel: IFunnel[] = []
    let totalPageviews: number = 0

    const promises = [
      (async () => {
        funnel = await this.analyticsService.getFunnel(pagesArr, params)
      })(),
      (async () => {
        totalPageviews = await this.analyticsService.getTotalPageviews(
          pid,
          groupFrom,
          groupTo,
        )
      })(),
    ]

    await Promise.all(promises)

    return {
      funnel,
      totalPageviews,
    }
  }

  @Get('meta')
  @Auth([], true, true)
  async getCustomEventMetadata(
    @Query() data: GetCustomEventMetadata,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ): Promise<ReturnType<typeof this.analyticsService.getCustomEventMetadata>> {
    const { pid } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    return this.analyticsService.getCustomEventMetadata(data)
  }

  @Get('property')
  @Auth([], true, true)
  async getPagePropertyMetadata(
    @Query() data: GetPagePropertyMetaDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ): Promise<ReturnType<typeof this.analyticsService.getPagePropertyMeta>> {
    const { pid } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    return this.analyticsService.getPagePropertyMeta(data)
  }

  @Get('filters')
  @Auth([], true, true)
  async getFilters(
    @Query() data: GetFiltersDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const { pid, type } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    return this.analyticsService.getFilters(pid, type)
  }

  @Get('chart')
  @Auth([], true, true)
  async getChartData(
    @Query() data: GetDataDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      period,
      timeBucket,
      from,
      to,
      filters,
      timezone = DEFAULT_TIMEZONE,
      mode = ChartRenderMode.PERIODICAL,
    } = data
    this.analyticsService.validatePID(pid)

    const [filtersQuery, filtersParams, parsedFilters, customEVFilterApplied] =
      this.analyticsService.getFiltersQuery(filters, DataType.ANALYTICS)

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFrom, groupTo } = this.analyticsService.getGroupFromTo(
      from,
      to,
      timeBucket,
      period,
      safeTimezone,
    )
    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const paramsData = {
      params: {
        pid,
        groupFrom,
        groupTo,
        ...filtersParams,
      },
    }

    const result = await this.analyticsService.groupChartByTimeBucket(
      timeBucket,
      groupFrom,
      groupTo,
      filtersQuery,
      paramsData,
      safeTimezone,
      customEVFilterApplied,
      mode,
    )

    return {
      ...result,
      appliedFilters: parsedFilters,
    }
  }

  @Get('performance')
  @Auth([], true, true)
  async getPerfData(
    @Query() data: GetDataDto & { measure: PerfMeasure },
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      period,
      timeBucket,
      from,
      to,
      filters,
      timezone = DEFAULT_TIMEZONE,
      measure = DEFAULT_MEASURE,
    } = data
    this.analyticsService.validatePID(pid)

    this.analyticsService.checkIfPerfMeasureIsValid(measure)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    let newTimeBucket = timeBucket
    let allowedTumebucketForPeriodAll
    let diff

    if (period === 'all') {
      const res = await this.analyticsService.getTimeBucketForAllTime(
        pid,
        period,
        timezone,
      )

      diff = res.diff
      // eslint-disable-next-line prefer-destructuring
      newTimeBucket = _includes(res.timeBucket, timeBucket)
        ? timeBucket
        : res.timeBucket[0]
      allowedTumebucketForPeriodAll = res.timeBucket
    }

    const [filtersQuery, filtersParams, parsedFilters] =
      this.analyticsService.getFiltersQuery(filters, DataType.PERFORMANCE)

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFrom, groupTo } = this.analyticsService.getGroupFromTo(
      from,
      to,
      newTimeBucket,
      period,
      safeTimezone,
      diff,
    )

    const subQuery = `FROM performance WHERE pid = {pid:FixedString(12)} ${filtersQuery} AND created BETWEEN {groupFrom:String} AND {groupTo:String}`

    const paramsData = {
      params: {
        pid,
        groupFrom,
        groupTo,
        ...filtersParams,
      },
    }

    const result = await this.analyticsService.groupPerfByTimeBucket(
      newTimeBucket,
      groupFrom,
      groupTo,
      subQuery,
      filtersQuery,
      paramsData,
      safeTimezone,
      measure,
    )

    return {
      ...result,
      appliedFilters: parsedFilters,
      timeBucket: allowedTumebucketForPeriodAll,
    }
  }

  @Get('performance/chart')
  @Auth([], true, true)
  async getPerfChartData(
    @Query() data: GetDataDto & { measure: PerfMeasure },
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      period,
      timeBucket,
      from,
      to,
      filters,
      timezone = DEFAULT_TIMEZONE,
      measure = DEFAULT_MEASURE,
    } = data
    this.analyticsService.validatePID(pid)

    this.analyticsService.checkIfPerfMeasureIsValid(measure)

    const [filtersQuery, filtersParams, parsedFilters] =
      this.analyticsService.getFiltersQuery(filters, DataType.PERFORMANCE)

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFrom, groupTo } = this.analyticsService.getGroupFromTo(
      from,
      to,
      timeBucket,
      period,
      safeTimezone,
    )
    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const paramsData = {
      params: {
        pid,
        groupFrom,
        groupTo,
        ...filtersParams,
      },
    }

    const chart = await this.analyticsService.getPerfChartData(
      timeBucket,
      from,
      to,
      filtersQuery,
      paramsData,
      safeTimezone,
      measure,
    )

    return {
      chart,
      appliedFilters: parsedFilters,
    }
  }

  @Get('user-flow')
  @Auth([], true, true)
  async getUserFlow(
    @Query() data: GetUserFlowDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ): Promise<IUserFlow | { appliedFilters: any[] }> {
    const { pid, period, from, to, timezone = DEFAULT_TIMEZONE, filters } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    let diff

    if (period === 'all') {
      const res = await this.analyticsService.getTimeBucketForAllTime(
        pid,
        period,
        timezone,
      )

      diff = res.diff
    }

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFrom, groupTo } = this.analyticsService.getGroupFromTo(
      from,
      to,
      null,
      period,
      safeTimezone,
      diff,
    )

    const [filtersQuery, filtersParams, parsedFilters] =
      this.analyticsService.getFiltersQuery(filters, DataType.ANALYTICS)

    const params = {
      pid,
      groupFrom,
      groupTo,
      ...filtersParams,
    }

    const flow = await this.analyticsService.getUserFlow(params, filtersQuery)

    return {
      ...flow,
      appliedFilters: parsedFilters,
    }
  }

  @Get('birdseye')
  @Auth([], true, true)
  // returns overall short statistics per project
  async getOverallStats(
    @Query() data: GetOverallStatsDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pids,
      pid,
      period,
      from,
      to,
      timezone = DEFAULT_TIMEZONE,
      filters,
    } = data
    const pidsArray = getPIDsArray(pids, pid)

    const validationPromises = _map(pidsArray, async currentPID => {
      this.analyticsService.validatePID(currentPID)
      await this.analyticsService.checkProjectAccess(
        currentPID,
        uid,
        headers['x-password'],
      )
    })

    await Promise.all(validationPromises)

    return this.analyticsService.getAnalyticsSummary(
      pidsArray,
      period,
      from,
      to,
      timezone,
      filters,
    )
  }

  @Get('performance/birdseye')
  @Auth([], true, true)
  async getPerformanceOverallStats(
    @Query() data: GetOverallStatsDto & { measure: PerfMeasure },
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pids,
      pid,
      period,
      from,
      to,
      timezone = DEFAULT_TIMEZONE,
      filters,
    } = data
    let { measure = DEFAULT_MEASURE } = data
    const pidsArray = getPIDsArray(pids, pid)

    this.analyticsService.checkIfPerfMeasureIsValid(measure)

    if (measure === 'quantiles') {
      measure = DEFAULT_MEASURE
    }

    const validationPromises = _map(pidsArray, async currentPID => {
      this.analyticsService.validatePID(currentPID)
      await this.analyticsService.checkProjectAccess(
        currentPID,
        uid,
        headers['x-password'],
      )
    })

    await Promise.all(validationPromises)

    return this.analyticsService.getPerformanceSummary(
      pidsArray,
      period,
      from,
      to,
      timezone,
      filters,
      measure,
    )
  }

  @Get('hb')
  async getHeartBeatStats(
    @Query() data,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ): Promise<object> {
    const { pids, pid } = data
    const pidsArray = getPIDsArray(pids, pid)

    const validationPromises = _map(pidsArray, async currentPID => {
      this.analyticsService.validatePID(currentPID)
      await this.analyticsService.checkProjectAccess(
        currentPID,
        uid,
        headers['x-password'],
      )
    })

    await Promise.all(validationPromises)

    const result = {}

    const keyCountPromises = _map(pidsArray, async currentPID => {
      result[currentPID] =
        await this.analyticsService.getOnlineUserCount(currentPID)
    })

    await Promise.all(keyCountPromises).catch(reason => {
      this.logger.error(`[GET /analytics/hb] ${reason}`)
      throw new InternalServerErrorException(
        'An error occured while calculating heartbeat statistics',
      )
    })

    return result
  }

  @Get('liveVisitors')
  @Auth([], true, true)
  async getLiveVisitors(
    @Query() queryParams,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ): Promise<object> {
    const { pid } = queryParams

    this.analyticsService.validatePID(pid)
    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const keys = await redis.keys(`hb:*:${pid}`)
    if (_isEmpty(keys)) {
      return []
    }

    const psids = _map(keys, key => key.split(':')[1])

    const query = `
      SELECT DISTINCT ON (psid)
        any(dv) AS dv,
        any(br) AS br,
        any(os) AS os,
        any(cc) AS cc,
        toString(psid) AS psid
      FROM analytics
      WHERE
        psid IN ({ psids: Array(String) })
        AND created > ({ createdAfter: String })
        AND pid = ({ pid: FixedString(12) })
      GROUP BY psid
    `

    const { data } = await clickhouse
      .query({
        query,
        query_params: {
          psids,
          createdAfter: dayjs
            .utc()
            .subtract(3, 'hours')
            .format('YYYY-MM-DDTHH:mm:ss'),
          pid,
        },
      })
      .then(resultSet => resultSet.json())

    return data
  }

  @Post('custom')
  @Public()
  async logCustom(
    @Body() eventsDTO: EventsDTO,
    @Headers() headers,
    @Ip() reqIP,
  ) {
    const { 'user-agent': userAgent, origin } = headers

    const ip = getIPFromHeaders(headers) || reqIP || ''

    this.analyticsService.validateCustomEVMeta(eventsDTO.meta)

    await this.analyticsService.throwIfBot(eventsDTO.pid, userAgent)
    await this.analyticsService.validate(eventsDTO, origin, 'custom', ip)

    if (eventsDTO.unique) {
      const [unique] = await this.analyticsService.isUnique(
        `${eventsDTO.pid}-${eventsDTO.ev}`,
        userAgent,
        ip,
      )

      if (!unique) {
        throw new ForbiddenException(
          'The unique option provided, while the custom event have already been created for this session',
        )
      }
    }

    const ua = UAParser(userAgent, extensions)
    const dv = ua.device.type || 'desktop'
    const br = ua.browser.name
    const os = ua.os.name

    const { city, region, country } = getGeoDetails(ip, eventsDTO.tz, headers)

    const [, psid] = await this.analyticsService.isUnique(
      eventsDTO.pid,
      userAgent,
      ip,
    )

    const transformed = customEventTransformer(
      psid,
      eventsDTO.pid,
      eventsDTO.ev,
      eventsDTO.pg,
      dv,
      br,
      os,
      eventsDTO.lc,
      eventsDTO.ref,
      eventsDTO.so,
      eventsDTO.me,
      eventsDTO.ca,
      eventsDTO.te,
      eventsDTO.co,
      country,
      region,
      city,
      eventsDTO.meta,
    )

    try {
      await clickhouse.insert({
        table: 'customEV',
        format: 'JSONEachRow',
        values: [transformed],
        clickhouse_settings: {
          async_insert: 1,
        },
      })
    } catch (e) {
      this.logger.error(e)
      throw new InternalServerErrorException(
        'Error occured while saving the custom event',
      )
    }
  }

  @Post('hb')
  @Auth([], true, true)
  async heartbeat(
    @Body() logDTO: PageviewsDTO,
    @Headers() headers,
    @Ip() reqIP,
  ) {
    const { 'user-agent': userAgent, origin } = headers
    const { pid } = logDTO
    const ip = getIPFromHeaders(headers) || reqIP || ''

    await this.analyticsService.throwIfBot(logDTO.pid, userAgent)

    await this.analyticsService.validateHeartbeat(logDTO, origin, ip)

    const [, psid] = await this.analyticsService.isUnique(pid, userAgent, ip)

    await redis.set(
      getHeartbeatKey(psid, pid),
      1,
      'EX',
      HEARTBEAT_SID_LIFE_TIME,
    )
    await this.analyticsService.processInteractionSD(psid, pid)
  }

  @Post()
  @Public()
  async log(@Body() logDTO: PageviewsDTO, @Headers() headers, @Ip() reqIP) {
    const { 'user-agent': userAgent, origin } = headers

    const ip = getIPFromHeaders(headers) || reqIP || ''

    await this.analyticsService.throwIfBot(logDTO.pid, userAgent)

    await this.analyticsService.validate(logDTO, origin, 'log', ip)

    const [unique, psid] = await this.analyticsService.isUnique(
      logDTO.pid,
      userAgent,
      ip,
    )

    await this.analyticsService.processInteractionSD(psid, logDTO.pid)

    if (unique && logDTO.unique) {
      throw new ForbiddenException(
        'The event was not saved because it was not unique while unique only param is provided',
      )
    }

    const { city, region, country } = getGeoDetails(ip, logDTO.tz, headers)

    const ua = UAParser(userAgent, extensions)
    const dv = ua.device.type || 'desktop'
    const br = ua.browser.name
    const os = ua.os.name

    const transformed = trafficTransformer(
      psid,
      logDTO.pid,
      logDTO.pg,
      logDTO.prev,
      dv,
      br,
      os,
      logDTO.lc,
      logDTO.ref,
      logDTO.so,
      logDTO.me,
      logDTO.ca,
      logDTO.te,
      logDTO.co,
      country,
      region,
      city,
      logDTO.meta,
      0,
      Number(unique),
    )

    let perfTransformed = null

    if (!_isEmpty(logDTO.perf) && isPerformanceValid(logDTO.perf)) {
      const {
        dns,
        tls,
        conn,
        response,
        render,
        dom_load: domLoad,
        page_load: pageLoad,
        ttfb,
      } = logDTO.perf

      perfTransformed = performanceTransformer(
        logDTO.pid,
        logDTO.pg,
        dv,
        br,
        country,
        region,
        city,
        dns,
        tls,
        conn,
        response,
        render,
        domLoad,
        pageLoad,
        ttfb,
      )
    }

    try {
      await clickhouse.insert({
        table: 'analytics',
        format: 'JSONEachRow',
        values: [transformed],
        clickhouse_settings: {
          async_insert: 1,
        },
      })

      if (!_isEmpty(perfTransformed)) {
        await clickhouse.insert({
          table: 'performance',
          format: 'JSONEachRow',
          values: [perfTransformed],
          clickhouse_settings: {
            async_insert: 1,
          },
        })
      }
    } catch (e) {
      this.logger.error(e)
      throw new InternalServerErrorException(
        'Error occured while saving the log data',
      )
    }
  }

  // Fallback for logging pageviews for users with JavaScript disabled
  // Returns 1x1 transparent gif
  @Get('noscript')
  @Public()
  async noscript(
    @Query() data,
    @Headers() headers,
    @Ip() reqIP,
    @Response() res,
  ) {
    const { 'user-agent': userAgent, origin } = headers
    const { pid } = data

    try {
      await this.analyticsService.throwIfBot(pid, userAgent)
    } catch {
      res.writeHead(200, { 'Content-Type': 'image/gif' })
      return res.end(TRANSPARENT_GIF_BUFFER, 'binary')
    }

    const logDTO: PageviewsDTO = {
      pid,
    }

    await this.analyticsService.validate(logDTO, origin)

    const ip = getIPFromHeaders(headers) || reqIP || ''
    const [unique, psid] = await this.analyticsService.isUnique(
      logDTO.pid,
      userAgent,
      ip,
    )

    await this.analyticsService.processInteractionSD(psid, logDTO.pid)

    const ua = UAParser(userAgent, extensions)
    const dv = ua.device.type || 'desktop'
    const br = ua.browser.name
    const os = ua.os.name

    const { city, region, country } = getGeoDetails(ip, null, headers)

    const transformed = trafficTransformer(
      psid,
      logDTO.pid,
      null,
      null,
      dv,
      br,
      os,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      country,
      region,
      city,
      null,
      0,
      Number(unique),
    )

    try {
      await clickhouse.insert({
        table: 'analytics',
        format: 'JSONEachRow',
        values: [transformed],
        clickhouse_settings: {
          async_insert: 1,
        },
      })
    } catch (e) {
      this.logger.error(e)
    }

    res.writeHead(200, { 'Content-Type': 'image/gif' })
    return res.end(TRANSPARENT_GIF_BUFFER, 'binary')
  }

  @Get('sessions')
  @Auth([], true, true)
  async getSessions(
    @Query() data: GetSessionsDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const { pid, period, from, to, filters, timezone = DEFAULT_TIMEZONE } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const take = this.analyticsService.getSafeNumber(data.take, 30)
    const skip = this.analyticsService.getSafeNumber(data.skip, 0)

    if (take > 150) {
      throw new BadRequestException(
        'The maximum number of sessions to return is 150',
      )
    }

    let timeBucket
    let diff

    if (period === 'all') {
      const res = await this.analyticsService.getTimeBucketForAllTime(
        pid,
        period,
        timezone,
      )

      // eslint-disable-next-line prefer-destructuring
      timeBucket = res.timeBucket[0]
      diff = res.diff
    } else {
      timeBucket = getLowestPossibleTimeBucket(period, from, to)
    }

    const [filtersQuery, filtersParams, appliedFilters, customEVFilterApplied] =
      this.analyticsService.getFiltersQuery(filters, DataType.ANALYTICS)

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFromUTC, groupToUTC } = this.analyticsService.getGroupFromTo(
      from,
      to,
      timeBucket,
      period,
      safeTimezone,
      diff,
    )

    const paramsData = {
      params: {
        pid,
        groupFrom: groupFromUTC,
        groupTo: groupToUTC,
        ...filtersParams,
      },
    }

    const sessions = await this.analyticsService.getSessionsList(
      filtersQuery,
      paramsData,
      safeTimezone,
      take,
      skip,
      customEVFilterApplied,
    )

    return {
      sessions,
      appliedFilters,
      take,
      skip,
    }
  }

  @Get('session')
  @Auth([], true, true)
  async getSession(
    @Query() data: GetSessionDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      psid,
      timezone = DEFAULT_TIMEZONE,
      //
    } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )
    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)

    const result = await this.analyticsService.getSessionDetails(
      pid,
      psid,
      safeTimezone,
    )

    return result
  }

  @Get('custom-events')
  @Auth([], true, true)
  async getCustomEvents(
    @Query() data: GetCustomEventsDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      period,
      timeBucket,
      from,
      to,
      filters,
      timezone = DEFAULT_TIMEZONE,
      customEvents,
    } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    let newTimeBucket = timeBucket
    let diff
    let timeBucketForAllTime

    if (period === VALID_PERIODS[VALID_PERIODS.length - 1]) {
      const res = await this.analyticsService.getTimeBucketForAllTime(
        pid,
        period,
        timezone,
      )

      // eslint-disable-next-line prefer-destructuring
      newTimeBucket = _includes(res.timeBucket, timeBucket)
        ? timeBucket
        : res.timeBucket[0]
      diff = res.diff
      timeBucketForAllTime = res.timeBucket
    }

    const [filtersQuery, filtersParams, parsedFilters] =
      this.analyticsService.getFiltersQuery(filters, DataType.ANALYTICS)

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFrom, groupTo } = this.analyticsService.getGroupFromTo(
      from,
      to,
      newTimeBucket,
      period,
      safeTimezone,
      diff,
    )

    const paramsData = {
      params: {
        pid,
        groupFrom,
        groupTo,
        ...filtersParams,
      },
    }

    const result: any = await this.analyticsService.groupCustomEVByTimeBucket(
      newTimeBucket,
      groupFrom,
      groupTo,
      filtersQuery,
      paramsData,
      safeTimezone,
    )

    let customEventss = customEvents

    if (filters) {
      try {
        customEventss = JSON.parse(customEvents)
        // eslint-disable-next-line no-empty
      } catch {}
    }

    if (customEventss.length > 0) {
      for (const key in result.chart.events) {
        if (!customEventss.includes(key)) {
          delete result.chart.events[key]
        }
      }
    } else {
      result.chart = {}
    }

    return {
      ...result,
      appliedFilters: parsedFilters,
      timeBucket: timeBucketForAllTime,
    }
  }

  @Get('errors-filters')
  @Auth([], true, true)
  async getErrorsFilters(
    @Query() data: GetFiltersDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const { pid, type } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    return this.analyticsService.getErrorsFilters(pid, type)
  }

  @Post('error')
  @Public()
  async logError(@Body() errorDTO: ErrorDTO, @Headers() headers, @Ip() reqIP) {
    const { 'user-agent': userAgent, origin } = headers

    const ip = getIPFromHeaders(headers) || reqIP || ''

    await this.analyticsService.throwIfBot(errorDTO.pid, userAgent)

    await this.analyticsService.validate(errorDTO, origin, 'error', ip)

    const { city, region, country } = getGeoDetails(ip, errorDTO.tz, headers)

    const ua = UAParser(userAgent, extensions)
    const dv = ua.device.type || 'desktop'
    const br = ua.browser.name
    const os = ua.os.name

    const { name, message, lineno, colno, filename } = errorDTO

    const transformed = errorEventTransformer(
      this.analyticsService.getErrorID(errorDTO),
      errorDTO.pid,
      errorDTO.pg,
      dv,
      br,
      os,
      errorDTO.lc,
      country,
      region,
      city,
      name,
      message,
      lineno,
      colno,
      filename,
    )

    try {
      await clickhouse.insert({
        table: 'errors',
        format: 'JSONEachRow',
        values: [transformed],
        clickhouse_settings: {
          async_insert: 1,
        },
      })
    } catch (e) {
      this.logger.error(e)
      throw new InternalServerErrorException(
        'Error occured while saving the custom event',
      )
    }
  }

  // Update error(s) status
  @Patch('error-status')
  @Auth([], true, true)
  async patchStatus(
    @Body() statusDTO: PatchStatusDTO,
    @CurrentUserId() uid: string,
    @Headers() headers,
    @Ip() reqIP,
  ) {
    const { pid, eid, eids: unprocessedEids, status } = statusDTO
    const ip = getIPFromHeaders(headers) || reqIP || ''

    await checkRateLimit(ip, 'error-status', 100, 1800)

    this.analyticsService.validatePID(pid)
    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const eids = getEIDsArray(unprocessedEids, eid)

    await this.analyticsService.validateEIDs(eids, pid)

    return this.analyticsService.updateEIDStatus(eids, status, pid)
  }

  @Get('errors')
  @Auth([], true, true)
  async getErrors(
    @Query() data: GetErrorsDto,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      period,
      from,
      to,
      filters,
      timezone = DEFAULT_TIMEZONE,
      options,
    } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    const take = this.analyticsService.getSafeNumber(data.take, 30)
    const skip = this.analyticsService.getSafeNumber(data.skip, 0)

    if (take > 150) {
      throw new BadRequestException(
        'The maximum number of errors to return is 150',
      )
    }

    let timeBucket
    let diff

    if (period === 'all') {
      const res = await this.analyticsService.getTimeBucketForAllTime(
        pid,
        period,
        timezone,
      )

      // eslint-disable-next-line prefer-destructuring
      timeBucket = res.timeBucket[0]
      diff = res.diff
    } else {
      timeBucket = getLowestPossibleTimeBucket(period, from, to)
    }

    const [filtersQuery, filtersParams, appliedFilters] =
      this.analyticsService.getFiltersQuery(filters, DataType.ANALYTICS)

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFromUTC, groupToUTC } = this.analyticsService.getGroupFromTo(
      from,
      to,
      timeBucket,
      period,
      safeTimezone,
      diff,
    )

    const paramsData = {
      params: {
        pid,
        groupFrom: groupFromUTC,
        groupTo: groupToUTC,
        ...filtersParams,
      },
    }

    const errors = await this.analyticsService.getErrorsList(
      options,
      filtersQuery,
      paramsData,
      safeTimezone,
      take,
      skip,
    )

    return {
      errors,
      appliedFilters,
      take,
      skip,
    }
  }

  @Get('get-error')
  @Auth([], true, true)
  async getError(
    @Query() data: GetErrorDTO,
    @CurrentUserId() uid: string,
    @Headers() headers: { 'x-password'?: string },
  ) {
    const {
      pid,
      timezone = DEFAULT_TIMEZONE,
      eid,
      period,
      from,
      to,
      //
    } = data
    this.analyticsService.validatePID(pid)

    await this.analyticsService.checkProjectAccess(
      pid,
      uid,
      headers['x-password'],
    )

    let timeBucket
    let diff

    if (period === 'all') {
      const res = await this.analyticsService.getTimeBucketForAllTime(
        pid,
        period,
        timezone,
      )

      // eslint-disable-next-line prefer-destructuring
      timeBucket = res.timeBucket[0]
      diff = res.diff
    } else {
      timeBucket = getLowestPossibleTimeBucket(period, from, to)
    }

    const safeTimezone = this.analyticsService.getSafeTimezone(timezone)
    const { groupFromUTC, groupToUTC } = this.analyticsService.getGroupFromTo(
      from,
      to,
      timeBucket,
      period,
      safeTimezone,
      diff,
    )

    const result = await this.analyticsService.getErrorDetails(
      pid,
      eid,
      safeTimezone,
      groupFromUTC,
      groupToUTC,
      timeBucket,
    )

    return result
  }
}
