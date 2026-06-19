/**
 * Единая точка сборки use-cases из инфраструктурных зависимостей.
 * Раньше половина графа собиралась в make-deps, половина — инлайном в роутере;
 * теперь весь прикладной слой инстанцируется здесь, один раз при старте.
 */
import {
  CreateMeetingUseCase,
  CreateProjectUseCase,
  MarkUploadCompletedUseCase,
  UpdateProjectTeamUseCase,
  RegisterUserUseCase,
  LoginUserUseCase
} from "../../../../packages/core/src/index.js";
import { verifyTotp } from "../shared/totp.js";

export function makeUseCases({
  projectRepository,
  meetingRepository,
  userRepository,
  artifactStorage,
  clock,
  idGenerator,
  passwordHasher,
  passwordVerifier,
  adminLogin
}) {
  return {
    createProject: new CreateProjectUseCase(projectRepository, clock, idGenerator),
    updateProjectTeam: new UpdateProjectTeamUseCase(projectRepository, clock),
    createMeeting: new CreateMeetingUseCase(
      projectRepository,
      meetingRepository,
      artifactStorage,
      clock,
      idGenerator
    ),
    markUploadCompleted: new MarkUploadCompletedUseCase(meetingRepository, clock),
    registerUser: new RegisterUserUseCase(
      userRepository,
      passwordHasher,
      clock,
      idGenerator,
      adminLogin
    ),
    loginUser: new LoginUserUseCase(
      userRepository,
      passwordVerifier,
      // TOTP-проверка (sync, чистая криптофункция)
      { verify: (secret, code) => verifyTotp(secret, code) },
      // Коды восстановления хэшируются тем же scrypt, что и пароли
      passwordVerifier,
      clock
    )
  };
}
