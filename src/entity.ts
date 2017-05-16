import { autoinject } from 'aurelia-dependency-injection';
import { SessionService, SessionPort } from './session';
import { Event, getEntityPositionInReferenceFrame, getSerializedEntityState, jsonEquals } from './utils';
import { SerializedEntityState, SerializedEntityStateMap } from './common';
import {
    defined,
    Cartesian3,
    Cartographic,
    Entity,
    EntityCollection,
    ConstantPositionProperty,
    ConstantProperty,
    JulianDate,
    Matrix3,
    Matrix4,
    ReferenceFrame,
    Transforms,
    Quaternion
} from './cesium/cesium-imports'

/**
 * A service for subscribing/unsubscribing to entities
 */
@autoinject()
export class EntityService {

    constructor(public collection:EntityCollection, protected sessionService: SessionService) {
        // sessionService.manager.on['ar.entity.state'] = ({id, state}: { id:string, state:SerializedEntityState }) => {
        //     this.updateEntityFromSerializedState(id, state);
        // }
        
        sessionService.manager.on['ar.entity.subscribed'] = (event: { id: string, options:any }) => {
            this._handleSubscribed(event);
        }
        
        sessionService.manager.on['ar.entity.unsubscribed'] = ({id}: { id: string }) => {
            this._handleUnsubscribed(id);
        }
    }

    public subscribedEvent = new Event<{id:string, options?:{}}>();
    public unsubscribedEvent = new Event<{id:string}>();

    public subscriptions = new Map<string, {}>();

    private _handleSubscribed(evt:{id:string, options?:{}}) {
        const s = this.subscriptions.get(evt.id);
        const stringifiedOptions = evt.options && JSON.stringify(evt.options);
        if (!s || JSON.stringify(s) === stringifiedOptions) {
            if (s) this._handleUnsubscribed(evt.id);
            this.subscriptions.set(evt.id, stringifiedOptions && JSON.parse(stringifiedOptions));
            this.subscribedEvent.raiseEvent(evt);
        };
    }

    private _handleUnsubscribed(id:string) {
        if (this.subscriptions.has(id)) {
            this.subscriptions.delete(id);
            this.unsubscribedEvent.raiseEvent({id});
        };
    }

    private _scratchCartesian = new Cartesian3;
    private _scratchQuaternion = new Quaternion;
    private _scratchMatrix3 = new Matrix3;
    private _scratchMatrix4 = new Matrix4;
    private _getEntityPositionInReferenceFrame = getEntityPositionInReferenceFrame;
    
    /**
     * Get the cartographic position of an Entity at the given time
     */
    public getCartographic(entity:Entity, time:JulianDate, result?:Cartographic) : Cartographic|undefined {
        const fixedPosition = 
            this._getEntityPositionInReferenceFrame(entity, time, ReferenceFrame.FIXED, this._scratchCartesian);
        
        if (fixedPosition) {
            result = result || new Cartographic();
            return Cartographic.fromCartesian(fixedPosition, undefined, result);
        }

        return undefined;
    }

     /**
     * Create an entity that is positioned at the given cartographic location,
     * with an orientation computed according to the provided `localToFixed` transform function.
     * 
     * For the `localToFixed` parameter, you can pass any of the following:
     * 
     * ```
     * Argon.Cesium.Transforms.eastNorthUpToFixedFrame
     * Argon.Cesium.Transforms.northEastDownToFixedFrame
     * Argon.Cesium.Transforms.northUpEastToFixedFrame
     * Argon.Cesium.Transforms.northWestUpToFixedFrame
     * ```
     *  
     * Additionally, argon.js provides:
     * 
     * ```
     * Argon.eastUpSouthToFixedFrame
     * ```
     * 
     * Alternative transform functions can be created with:
     * 
     * ```
     * Argon.Cesium.Transforms.localFrameToFixedFrameGenerator
     * ```
     */
    public createFixed(cartographic: Cartographic, localToFixed: typeof Transforms.northUpEastToFixedFrame) : Entity {
        // Convert the cartographic location to an ECEF position
        var position = Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, cartographic.height, undefined, this._scratchCartesian);

        // compute an appropriate orientation on the surface of the earth
        var transformMatrix = localToFixed(position, undefined, this._scratchMatrix4);
        var rotationMatrix = Matrix4.getRotation(transformMatrix,this._scratchMatrix3)
        var orientation = Quaternion.fromRotationMatrix(rotationMatrix, this._scratchQuaternion);

        // create the entity
        var entity = new Entity({
            position,
            orientation
        });
        return entity;
    }

    /**
     * Subscribe to pose updates for the given entity id
     * 
     * @returns A Promise that resolves to a new or existing entity 
     * instance matching the given id, if the subscription is successful
     */
    public subscribe(idOrEntity: string|Entity) : Promise<Entity>;
    public subscribe(idOrEntity: string|Entity, options?:{}, session?:SessionPort) : Promise<Entity>;
    public subscribe(idOrEntity: string|Entity, options?:{}, session=this.sessionService.manager) : Promise<Entity> {
        const id = (<Entity>idOrEntity).id || <string>idOrEntity;
        const evt = {id, options};
        return session.request('ar.entity.subscribe', evt).then(()=>{
            const entity = this.collection.getOrCreateEntity(id);
            this._handleSubscribed(evt);
            return entity;
        });
    }

    /**
     * Unsubscribe to pose updates for the given entity id
     */
    public unsubscribe(idOrEntity) : void;
    public unsubscribe(idOrEntity: string|Entity, session?:SessionPort) : void;
    public unsubscribe(idOrEntity: string|Entity, session=this.sessionService.manager) : void {
        const id = (<Entity>idOrEntity).id || <string>idOrEntity;
        session.send('ar.entity.unsubscribe', {id});
        this._handleUnsubscribed(id);
    }

    /**
     * 
     * @param id 
     * @param entityState 
     */
    public updateEntityFromSerializedState(id:string, entityState:SerializedEntityState|null) {
        const entity = this.collection.getOrCreateEntity(id);
        
        if (!entityState) {
            if (entity.position) {
                (entity.position as ConstantPositionProperty).setValue(undefined);
            }
            if (entity.orientation) {
                (entity.orientation as ConstantProperty).setValue(undefined);
            }
            entity['meta'] = undefined;
            return entity;
        }
        
        const positionValue = entityState.p;
        const orientationValue = Quaternion.clone(entityState.o, this._scratchQuaternion); // workaround for https://github.com/AnalyticalGraphicsInc/cesium/issues/5031
        const referenceFrame:Entity|ReferenceFrame = 
            typeof entityState.r === 'number' ?
            entityState.r : this.collection.getOrCreateEntity(entityState.r);

        let entityPosition = entity.position;
        let entityOrientation = entity.orientation;

        if (entityPosition instanceof ConstantPositionProperty) {
            entityPosition.setValue(positionValue, referenceFrame);
        } else {
            entity.position = new ConstantPositionProperty(positionValue, referenceFrame);
        }

        if (entityOrientation instanceof ConstantProperty) {
            entityOrientation.setValue(orientationValue);
        } else {
            entity.orientation = new ConstantProperty(orientationValue);
        }

        entity['meta'] = entityState.meta;

        return entity;
    }

}


/**
 * A service for publishing entity states to managed sessions
 */
@autoinject
export class EntityServiceProvider {

    public subscriptionsBySubscriber = new WeakMap<SessionPort, Map<string,{}|undefined>>();
    public subscribersByEntity = new Map<string, Set<SessionPort>>();
    public sessionSubscribedEvent = new Event<{session:SessionPort, id:string, options:{}}>();
    public sessionUnsubscribedEvent = new Event<{session:SessionPort, id:string}>();

    public targetReferenceFrameMap = new Map<string, string|ReferenceFrame>();

    constructor(private sessionService: SessionService, private entityService: EntityService) {
        this.sessionService.ensureIsRealityManager();
        
        this.sessionService.connectEvent.addEventListener((session) => {
            const subscriptions = new Map<string, {}|undefined>();
            this.subscriptionsBySubscriber.set(session, subscriptions);

            session.on['ar.entity.subscribe'] = session.on['ar.context.subscribe'] = ({id, options}:{id:string, options:any}) => {
                const currentOptions = subscriptions.get(id);
                if (currentOptions && jsonEquals(currentOptions,options)) return;

                return Promise.resolve(this.onAllowSubscription(session, id, options)).then(()=>{
                    const subscribers = this.subscribersByEntity.get(id) || new Set<SessionPort>();
                    this.subscribersByEntity.set(id, subscribers);
                    subscribers.add(session);
                    subscriptions.set(id,options);
                    this.sessionSubscribedEvent.raiseEvent({session, id, options});
                });
            }

            session.on['ar.entity.unsubscribe'] = session.on['ar.context.unsubscribe'] = ({id}:{id:string}) => {
                if (!subscriptions.has(id)) return;

                const subscribers = this.subscribersByEntity.get(id);
                subscribers && subscribers.delete(session);
                subscriptions.delete(id);
                this.sessionUnsubscribedEvent.raiseEvent({id, session});
            }

            session.closeEvent.addEventListener(()=>{
                this.subscriptionsBySubscriber.delete(session);
                subscriptions.forEach((options, id)=>{
                    const subscribers = this.subscribersByEntity.get(id);
                    subscribers && subscribers.delete(session);
                    this.sessionUnsubscribedEvent.raiseEvent({id, session});
                });
            })
        });
    }

    /**
     * Should return a resolved promise if subscription is permitted, 
     * or a rejected promise if subscription is not permitted.
     */
    public onAllowSubscription(session, id, options) {
        return Promise.resolve();
    }

    public fillEntityStateMapForSession(session:SessionPort, time:JulianDate, entities:SerializedEntityStateMap) {
        const subscriptions = this.subscriptionsBySubscriber.get(session);
        if (!subscriptions) return;
        for (const id in subscriptions) {
            const entity = this.entityService.collection.getById(id);
            entities[id] = entity ? this.getCachedSerializedEntityState(entity, time) : null;
        }
    }

    private _cacheTime = new JulianDate(0,0)
    private _entityPoseCache: SerializedEntityStateMap = {};
    private _getSerializedEntityState = getSerializedEntityState;

    public getCachedSerializedEntityState(entity: Entity|undefined, time: JulianDate) {
        if (!entity) return null;

        const id = entity.id;

        if (!defined(this._entityPoseCache[id]) || this._cacheTime.equalsEpsilon(time, 0.000001)) {
            const referenceFrameId = this.targetReferenceFrameMap.get(id);
            const referenceFrame = defined(referenceFrameId) && typeof referenceFrameId === 'string' ? 
                this.entityService.collection.getById(referenceFrameId) :
                defined(referenceFrameId) ? referenceFrameId : this.entityService.collection.getById('ar.origin');
            this._entityPoseCache[id] = this._getSerializedEntityState(entity, time, referenceFrame);
        }

        return this._entityPoseCache[id];
    }
}